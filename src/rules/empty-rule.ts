// Responsibility: rule 4, the empty rule set (ArchUnitTS's Empty Test
// Protection). A configured rule that matches zero real things must not
// look like a pass — the same "a zero can look like success when it is
// really an omission" principle as rule 3, from the other direction: rule
// 3 is "a file no declared module covers is a failure"; this is "a
// declaration (a module, or a classify glob) that covers no real file is
// a failure". Also reports allow lists that cover every real target value.
// Boundary: a config-vs-graph consistency check, not an edge check. No
// I/O, no output formatting.
import type { Config } from "../config/config.js";
import { assertDeprecatedModulesExist } from "./deprecated.js";
import { classifyFile, compileGlob } from "../config/classify.js";
import { type ModuleGraph } from "../graph/module-graph.js";
import { checkEdgesCoverage, checkExhaustiveAllow, formatPredicate, matchesPredicate, type FromToPredicate } from "./constraints.js";
import { withPointerSpecs } from "../config/config-pointer.js";

export type Violation = {
  rule: "empty-rule-set" | "exhaustive-allow-list";
  path: string; // config.configPath — this is a config-vs-graph check, not an edge check
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

const BECAUSE =
  "a rule that checks nothing must not look like a pass";

function violation(config: Config, evidence: string, doText: string, pointer: string): Violation {
  return withPointerSpecs({
    rule: "empty-rule-set",
    path: config.configPath,
    line: 1,
    column: 1,
    evidence,
    because: BECAUSE,
    do: doText,
  }, [{ pointer, role: "fired" }]);
}

// Every finding here reports at `config.configPath` (see the Violation
// type's own comment above) - a config-vs-graph consistency fact, never a
// single file's own edge - so this rule always runs its current,
// whole-config logic regardless of a `check <file>` run's own focus;
// runRules' own end-of-call filter (not this function) is what keeps or
// drops it depending on whether focus names the config file itself.
export function checkEmptyRuleSet(graph: ModuleGraph, config: Config): Violation[] {
  // Validated up front, same reasoning as ever: a config error must not
  // depend on which branch runs first.
  assertDeprecatedModulesExist(graph, config);

  // No modules at all: not "a rule matched zero", but "nothing to check" -
  // reported the same way (a violation, not a thrown error) so it fits
  // the same 0-is-a-result shape as everything else `check` reports.
  // Returned immediately rather than falling through to the classify loop
  // below: with zero modules, every classify glob trivially matches
  // nothing that belongs to any module either, so the loop would add one
  // redundant violation per entry, all restating the same root cause.
  if (graph.modules.size === 0) {
    return [
      violation(
        config,
        "no modules declared in declaredModules",
        "add at least one declaredModules entry in archstrict.config.ts",
        "declaredModules",
      ),
    ];
  }

  const violations: Violation[] = [];

  // Every classify glob must match at least one real, in-scope file, and
  // must supply the tags of at least one file it matches. A glob that
  // matches nothing is a typo or a stale entry. A glob that matches files
  // but loses every one of them to a more specific entry applies no tags,
  // which is the same omission: the file keeps the broader entry's tags
  // and this entry looks like it worked. Who wins stays most-specific
  // (longest literal prefix, then fewest wildcards). That precedence is
  // also how a file picks its module, so a losing glob is reported here
  // instead of being promoted. A tie on specificity is a config error
  // raised when the file is classified, not this report.
  const allFiles = [...graph.modules.values()].flatMap((m) => m.files).concat(graph.outsideFiles);
  const classify = config.classify ?? [];
  for (const [entryIndex, entry] of classify.entries()) {
    const glob = compileGlob(entry.glob);
    const matched = allFiles.filter((file) => glob.test(graph.relativePath(file)));
    if (matched.length === 0) {
      violations.push(
        violation(
          config,
          `classify glob '${entry.glob}' matches no file in scope`,
          `remove this classify entry from archstrict.config.ts, or point its glob at real files`,
          `classify[${entryIndex}]`,
        ),
      );
      continue;
    }
    if (matched.every((file) => classifyGlobLoses(graph.relativePath(file), entry, classify))) {
      const files = matched.length === 1 ? "file" : "files";
      violations.push(
        violation(
          config,
          `classify glob '${entry.glob}' matches ${matched.length} ${files} but a more specific glob supplies their tags`,
          `lengthen this glob's literal prefix, or use fewer wildcards at the same prefix, so it wins for the files it should tag, or remove the entry from classify in archstrict.config.ts`,
          `classify[${entryIndex}]`,
        ),
      );
    }
  }

  // A friends entry that matches nothing exempts no import. `file` is
  // matched inside the module, the same paths rule 1 tests. `from` is
  // matched against every analyzed file. Either miss is its own finding,
  // because fixing one glob does not fix the other.
  for (const [moduleIndex, declared] of (config.declaredModules ?? []).entries()) {
    const module = graph.modules.get(declared.name);
    if (module === undefined) continue;
    const moduleRels = module.files.map((file) => graph.relativePath(file));
    // A visibility that matches no file makes the module unreachable, which
    // reads as a clean pass while it is a typo.
    if (declared.visibility !== undefined && !allFiles.some((file) => compileGlob(declared.visibility!).test(graph.relativePath(file)))) {
      violations.push(
        violation(
          config,
          `visibility '${declared.visibility}' on module '${declared.name}' matches no file in scope`,
          `fix the visibility glob or remove it from module '${declared.name}' in archstrict.config.ts`,
          `declaredModules[${moduleIndex}].visibility`,
        ),
      );
    }
    for (const [friendIndex, friend] of (declared.friends ?? []).entries()) {
      const stored = module.friends[friendIndex];
      if (stored === undefined) continue;
      const pointer = `declaredModules[${moduleIndex}].friends[${friendIndex}]`;
      if (!moduleRels.some((rel) => compileGlob(stored.fileGlob).test(rel))) {
        violations.push(
          violation(
            config,
            `friends file '${friend.file}' on module '${declared.name}' matches no file in that module`,
            `fix the file glob or remove this friends entry from module '${declared.name}' in archstrict.config.ts`,
            pointer,
          ),
        );
      }
      if (!allFiles.some((file) => compileGlob(friend.from).test(graph.relativePath(file)))) {
        violations.push(
          violation(
            config,
            `friends from '${friend.from}' on module '${declared.name}' matches no file in scope`,
            `fix the from glob or remove this friends entry from module '${declared.name}' in archstrict.config.ts`,
            pointer,
          ),
        );
      }
    }
  }

  // A deprecated edge whose actual count has fallen to zero is not merely
  // smaller (rule 5's "update count" suggestion) — the edge is gone
  // entirely, so the entry itself is moot and checks nothing. Rule 5
  // deliberately does not report this case (its own header explains why),
  // so it belongs here instead: an empty-rule-set violation, not a count
  // to shrink.
  for (const [entryIndex, entry] of (config.deprecated ?? []).entries()) {
    const actual = graph.crossModuleEdges.filter(
      (e) => e.fromModule === entry.from && e.toModule === entry.to,
    ).length;
    if (actual === 0) {
      violations.push(
        violation(
          config,
          `deprecated edge '${entry.from} -> ${entry.to}' (declared count ${entry.count}) no longer exists`,
          `remove the '${entry.from} -> ${entry.to}' entry from deprecated in archstrict.config.ts`,
          `deprecated[${entryIndex}]`,
        ),
      );
    }
  }

  // An allowDeny/order/point rule whose own source/target combination
  // never applies to any real edge in the graph is the constraint
  // engine's own version of the same idea: a rule that structurally
  // cannot fire must not look like a clean pass. This only catches the
  // zero case. For an allow list, a genuine pass also needs a real target
  // value outside the list, after the source-group exemption. Otherwise,
  // the list guarantees a pass; the exhaustive-list check reports it below.
  // rules.md explains why a nonzero clean result still needs a positive
  // control, which these checks cannot replace. A `guard` rule's zero is
  // accepted while guardGap finds nothing missing.
  const coverageIndices = { allowDeny: 0, order: 0, point: 0 };
  let fileTags: { rel: string; tags: Set<string> }[] | undefined;
  const taggedFiles = () => fileTags ??= allFiles.map((file) => {
    const rel = graph.relativePath(file);
    return { rel, tags: classifyFile(rel, config) };
  });
  for (const c of checkEdgesCoverage(graph, config)) {
    const entryIndex = coverageIndices[c.kind]++;
    if (c.evaluated !== 0) continue;
    const rule = c.kind === "order" ? undefined : config.edges?.[c.kind]?.[entryIndex];
    const gap = rule === undefined ? undefined : guardGap(config, taggedFiles(), rule);
    if (rule?.guard === true && gap === undefined) continue;
    const doText = `remove or correct this ${c.kind} entry in archstrict.config.ts's edges - its own source/target never applies to any real edge this project has (a workspace-sibling import may resolve as an external package rather than a project tag; see rules.md)`;
    violations.push(
      violation(
        config,
        rule?.guard === true
          ? `guard ${c.kind} rule '${c.identifier}' matches no real edge in scope, and ${gap}`
          : `${c.kind} rule '${c.identifier}' matches no real edge in scope`,
        rule !== undefined && gap === undefined
          ? `${doText}. If it bans an import no file has yet, set guard: true on it and prove it fires with archstrict simulate (see prove-rules.md)`
          : doText,
        `edges.${c.kind}[${entryIndex}]`,
      ),
    );
  }

  for (const { identifier, rule } of checkExhaustiveAllow(graph, config)) {
    // Stryker disable next-line OptionalChaining,ArrayDeclaration: An exhaustive allow result comes from the defined allowDeny configuration.
    const entryIndex = (config.edges?.allowDeny ?? []).indexOf(rule);
    violations.push(withPointerSpecs({
      rule: "exhaustive-allow-list", path: config.configPath, line: 1, column: 1,
      evidence: `allowDeny rule '${identifier}' allows every real target value with allow ${JSON.stringify(rule.allow)}`,
      because: rule.because,
      do: `narrow the allow list for '${identifier}' in archstrict.config.ts to a genuine subset of real target values, or remove the rule if it should forbid nothing today`,
    }, [{ pointer: `edges.allowDeny[${entryIndex}].allow`, role: "fired" }]));
  }

  return violations;
}

type GuardableRule =
  | { source: string; targetNamespace: string; deny?: readonly string[]; guard?: boolean }
  | { from: FromToPredicate; to: FromToPredicate; guard?: boolean };

// A guard's zero is only its clean state while the rule could still fire:
// its source names a real file, and its target names a real file or a tag
// classify can assign. A pkg target is left to the positive control, since
// a ban on a package nobody installed yet is the point of a guard; so are
// allow values, which name what is permitted rather than what is banned.
// Returns what is missing, or undefined when nothing is.
function guardGap(config: Config, files: readonly { rel: string; tags: Set<string> }[], rule: GuardableRule): string | undefined {
  const assigned = new Set((config.classify ?? []).flatMap((entry) => entry.tags));
  const byName = config.classifyByDirectoryName;
  if (byName) for (const name of byName.names) assigned.add(`${byName.tagNamespace}:${name}`);
  const namespaces = new Set([...assigned].map(namespaceOf));
  if ("source" in rule) {
    if (!files.some((file) => file.tags.has(rule.source))) return `its source '${rule.source}' tags no file in scope`;
    if (rule.targetNamespace === "pkg") return undefined;
    if (!namespaces.has(rule.targetNamespace)) return `its targetNamespace '${rule.targetNamespace}' is neither pkg nor a namespace classify assigns`;
    const typo = (rule.deny ?? []).find((value) => !assigned.has(`${rule.targetNamespace}:${value}`));
    return typo === undefined ? undefined : `its deny value '${typo}' is not a '${rule.targetNamespace}:' value classify assigns`;
  }
  if (!files.some((file) => matchesPredicate(rule.from, file.rel, file.tags))) return `its from '${formatPredicate(rule.from)}' matches no file in scope`;
  if (typeof rule.to === "string") {
    const to = compileGlob(rule.to);
    return files.some((file) => to.test(file.rel)) ? undefined : `its to '${rule.to}' matches no file in scope`;
  }
  const unknown = rule.to.tags.find((tag) => namespaceOf(tag) !== "pkg" && !assigned.has(tag));
  return unknown === undefined ? undefined : `its to tag '${unknown}' is neither a pkg tag nor a tag classify assigns`;
}

function namespaceOf(tag: string): string {
  return tag.split(":")[0]!;
}

function sameTagList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

// True when some other matching entry is strictly more specific and its
// tags are the ones the file receives. Equal specificity is left alone:
// agreeing tags already apply, and disagreeing tags throw when the file
// is classified.
function classifyGlobLoses(
  rel: string,
  entry: { glob: string; tags: readonly string[] },
  entries: readonly { glob: string; tags: readonly string[] }[],
): boolean {
  const own = compileGlob(entry.glob);
  let best = own;
  let bestTags = entry.tags;
  let tiedWithDifferentTags = false;
  for (const other of entries) {
    const compiled = compileGlob(other.glob);
    if (!compiled.test(rel)) continue;
    const longerPrefix = compiled.literalPrefixLength > best.literalPrefixLength;
    const fewerWildcards = compiled.literalPrefixLength === best.literalPrefixLength && compiled.wildcardCount < best.wildcardCount;
    if (longerPrefix || fewerWildcards) {
      best = compiled;
      bestTags = other.tags;
      tiedWithDifferentTags = false;
      continue;
    }
    const tied = compiled.literalPrefixLength === best.literalPrefixLength && compiled.wildcardCount === best.wildcardCount;
    if (tied && !sameTagList(other.tags, bestTags)) tiedWithDifferentTags = true;
  }
  if (tiedWithDifferentTags) return false;
  const beaten = best.literalPrefixLength > own.literalPrefixLength
    || (best.literalPrefixLength === own.literalPrefixLength && best.wildcardCount < own.wildcardCount);
  return beaten && !sameTagList(bestTags, entry.tags);
}
