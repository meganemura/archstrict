// Responsibility: the constraint engine over `config.edges` - three
// shapes, generalizing over tags (src/classify.ts) instead of the fixed
// module/kind vocabulary rules 1-6 use. `allowDeny` (a source tag's
// allow/deny list over one target namespace at a time), `order` (a tag
// namespace's sequence, scoped within another namespace's equal value),
// and `point` (an explicit from/to edge, glob or tag-predicate on either
// side). One shared idea across all three: a rule scoped to a namespace
// says nothing about a target with no tag in that namespace - that's rule
// 3's ("uncovered") territory, not this rule's concern.
//
// Composition rule (the one sentence an implementer would otherwise get
// wrong): each `allowDeny`/`order` rule is evaluated independently, blind
// to every other rule's namespace. An edge violates if ANY ONE applicable
// rule says no - a plane-scoped rule and a domain-scoped rule can each
// clear the same edge or each independently condemn it; neither knows the
// other exists.
//
// `edgeType`/`importForm` filter which edges a rule can match at all,
// checked before the rule's own from/to or allow/deny logic runs. Default
// "both" for each - unfiltered, matching every prior ticket's edges.
// Also identifies allow lists that cover every real target value in the graph.
// Boundary: pure predicates over a ModuleGraph and a Config, same as every
// other rule file. No I/O, no output formatting, no todo handling.
import { computeMoves, type Move } from "./moves.js";
// Move is part of ConstraintViolation's public shape. Naming it from this
// surface keeps moves.ts private: only constraints.ts imports that file.
export type { Move };
import { compileGlob } from "../classify.js";
import { classifyFile } from "../classify.js";
import { type Edge, type ModuleGraph } from "../module-graph.js";
import type { ProjectRelativePath } from "../project-path.js";
import type { Config } from "../config.js";
import { ReportError } from "../report-error.js";
import { withPointerSpecs } from "../config-pointer.js";

export type ConstraintViolation = {
  rule: "tag-boundary" | "tag-order" | "point-rule";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
  todoModule: string;
  moves?: Move[];
};

// One entry per configured allowDeny/order/point rule, regardless of
// whether it ever violates - `evaluated` is how many real edges reached
// the point where this specific rule could have found a violation (passed
// its own edge filters, its source/from side, and - for allowDeny/order -
// genuinely had a tag in the rule's own target namespace to judge). A
// rule whose own source/target combination never applies to any real
// edge is not "clean" - checkEmptyRuleSet (rule 4) reports it as its own
// finding rather than a silent 0. `identifier` is a human-readable name
// for that violation's evidence text, not a stored config field (none of
// the three rule shapes has its own name).
export type EdgeRuleCoverage = {
  kind: "allowDeny" | "order" | "point";
  identifier: string;
  evaluated: number;
};

type AllowDenyRule = NonNullable<Config["edges"]>["allowDeny"] extends readonly (infer R)[] | undefined ? R : never;
type OrderRule = NonNullable<Config["edges"]>["order"] extends readonly (infer R)[] | undefined ? R : never;
type PointRule = NonNullable<Config["edges"]>["point"] extends readonly (infer R)[] | undefined ? R : never;
export type FromToPredicate = string | { tags: readonly string[]; exclude?: { tags: readonly string[] } };

export function formatPredicate(predicate: FromToPredicate): string {
  return typeof predicate === "string" ? predicate : JSON.stringify(predicate);
}

// A resolved edge's target tags: a synthesized `pkg:<name>` tag when the
// edge reaches outside this project entirely (a real npm package, a
// workspace dependency, a node builtin - module-graph.ts's own
// `externalPackage`), or the classified tags of the real file otherwise.
//
// A package shipping no bundled type declarations of its own resolves
// through its own `@types/<name>` shadow package instead - TypeScript's
// own resolver, not this project's choice - so `externalPackage` carries
// that shadow identity, not the bare specifier a rule author actually
// wrote. Measured directly, against a real project: two ordinary
// packages resolved to their own real name; two others (shipping no
// bundled types) resolved to their own `@types/` identity instead, so a
// deny/allow/point rule written against the bare name matched zero real
// edges - silently, with `evaluated` still nonzero (the edge WAS judged,
// just against the wrong identity), so rule 4's own empty-rule-set check
// could never have caught it. Both identities are tagged so a rule
// written against either one matches the same real edge.
function tagsForTarget(edge: Edge, config: Config, relativePath: ProjectRelativePath): Set<string> {
  if (edge.externalPackage !== undefined) {
    const tags = new Set([`pkg:${edge.externalPackage}`]);
    const barePackage = bareNameFromTypesPackage(edge.externalPackage);
    if (barePackage !== undefined) tags.add(`pkg:${barePackage}`);
    // A node builtin's own resolvedFile is synthesized as "node:<name>"
    // (module-graph.ts's own convention - no real file exists for one) -
    // the one reliable signal distinguishing it from a real npm package,
    // whose resolvedFile is always a genuine filesystem path. Without
    // this, a rule author who wants to ban every Node builtin from a
    // browser-runtime layer or similar has to enumerate each bare name
    // (pkg:fs, pkg:path, ...) individually, which silently under-protects
    // against a future builtin nobody thought to add when writing the
    // rule - a real, measured case, authoring a rule against a real
    // bundler tool's own source. `pkg:node` matches every builtin at
    // once; a rule naming one specific builtin still works exactly as
    // before, since its own bare-name tag is unchanged.
    if (edge.resolvedFile.startsWith("node:")) tags.add("pkg:node");
    return tags;
  }
  return classifyFile(relativePath(edge.resolvedFile), config);
}

// DefinitelyTyped's own naming convention: an unscoped package "foo" ships
// as "@types/foo"; a scoped package "@scope/foo" ships as
// "@types/scope__foo" (a literal double underscore standing in for the
// slash, since npm package names can't nest a real "/" under a scope
// beyond the scope itself).
function bareNameFromTypesPackage(packageName: string): string | undefined {
  if (!packageName.startsWith("@types/")) return undefined;
  const rest = packageName.slice("@types/".length);
  const scopeSplit = rest.indexOf("__");
  return scopeSplit === -1 ? rest : `@${rest.slice(0, scopeSplit)}/${rest.slice(scopeSplit + 2)}`;
}

// A glob can only match a real project-relative path - an external
// target's `resolvedFile` (node_modules, or a synthesized "node:x" for a
// builtin) has no such path, so a string `to`/`from` predicate simply
// never matches an external edge; only a tag predicate (matching the
// synthesized `pkg:` tag) can.
function targetRelPathForGlob(edge: Edge, relativePath: ProjectRelativePath): string | undefined {
  return edge.externalPackage !== undefined ? undefined : relativePath(edge.resolvedFile);
}

function matchesEdgeFilters(
  edge: Edge,
  edgeType: "value" | "type" | "both" | undefined,
  importForm: "static" | "dynamic" | "both" | undefined,
): boolean {
  if (edgeType === "value" && edge.isTypeOnly) return false;
  if (edgeType === "type" && !edge.isTypeOnly) return false;
  if (importForm === "static" && edge.isDynamic) return false;
  if (importForm === "dynamic" && !edge.isDynamic) return false;
  return true;
}

export function matchesPredicate(predicate: FromToPredicate, relPath: string | undefined, tags: Set<string>): boolean {
  if (typeof predicate === "string") {
    return relPath !== undefined && compileGlob(predicate).test(relPath);
  }
  if (!predicate.tags.every((t) => tags.has(t))) return false;
  if (predicate.exclude !== undefined && predicate.exclude.tags.every((t) => tags.has(t))) return false;
  return true;
}

export function isExemptedByGlobPair(
  edge: Edge,
  exceptions: readonly { from: string; to: string; because: string }[] | undefined,
  relativePath: ProjectRelativePath,
): boolean {
  if (exceptions === undefined || exceptions.length === 0) return false;
  const fromRel = relativePath(edge.fromFile);
  const toRel = targetRelPathForGlob(edge, relativePath);
  return exceptions.some(
    (ex) => compileGlob(ex.from).test(fromRel) && toRel !== undefined && compileGlob(ex.to).test(toRel),
  );
}

// `graph.edges` follows the edge build's own walk order (rootNames order -
// a directory scan, not a promise about reading order across files), not
// a promise about output order - checkAllowDeny/checkOrder/checkPoint
// (not their own compute* helpers, which return each match's own
// ruleIndex/coverage bookkeeping alongside it, order and all) sort by
// this before returning their own violations, so that output stays
// stable regardless of it. Code-unit order (`<`/`>`), not localeCompare:
// a locale-aware compare can order the same two paths differently on
// different machines.
function byPosition<T extends { path: string; line: number; column: number }>(a: T, b: T): number {
  return (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.column - b.column;
}

export type AllowDenyMatch = { violation: ConstraintViolation; edge: Edge; ruleIndex: number; violatingTag: string };

// `focus`, threaded through all three of this file's own rule shapes
// (allowDeny/order/point below), is check()'s own realpath'd target for a
// `check <file>` run - every one of the three reports at `edge.fromFile`
// (compared directly, not through `resolve()`: an edge's own `fromFile` is
// always already an absolute, real path, the same invariant
// checkPublicSurfaceBypass's own comment already documents), never at any
// other path. Unlike rule 1, `focus` here only gates what gets pushed into
// `violations`/`matches` - the loop still runs over every real edge in
// `graph.edges` regardless, because `evaluatedCounts` (and so
// `EdgeRuleCoverage.evaluated`, which checkEdgesCoverage's own callers use
// unscoped - checkEmptyRuleSet's own vacuous-rule check needs the real,
// whole-project count, not a count of one file's own edges) has to stay a
// whole-project fact either way.
export function computeAllowDeny(
  graph: ModuleGraph,
  config: Config,
  focus?: string,
): { violations: ConstraintViolation[]; coverage: EdgeRuleCoverage[]; matches: AllowDenyMatch[] } {
  const rules: readonly AllowDenyRule[] = config.edges?.allowDeny ?? [];
  const relativePath = graph.relativePath;
  const violations: ConstraintViolation[] = [];
  const matches: AllowDenyMatch[] = [];
  const evaluatedCounts = rules.map(() => 0);
  if (rules.length === 0) return { violations, coverage: [], matches };

  for (const edge of graph.edges) {
    const sourceTags = classifyFile(relativePath(edge.fromFile), config);
    if (sourceTags.size === 0) continue;
    const targetTags = tagsForTarget(edge, config, relativePath);
    if (targetTags.size === 0) continue;

    rules.forEach((rule, i) => {
      if (!matchesEdgeFilters(edge, rule.edgeType, rule.importForm)) return;
      if (!sourceTags.has(rule.source)) return;
      if (targetTags.has(rule.source)) return; // same group as source: unconstrained by this rule
      if (isExemptedByGlobPair(edge, rule.exceptions, relativePath)) return;

      const namespacePrefix = `${rule.targetNamespace}:`;
      const targetValues = [...targetTags].filter((t) => t.startsWith(namespacePrefix));
      if (targetValues.length === 0) return; // no tag in this namespace: not this rule's concern

      evaluatedCounts[i]!++; // this rule genuinely had a real edge to judge, whatever the verdict below

      let violatingTag: string | undefined;
      if (rule.allow !== undefined) {
        const allowed = new Set(rule.allow.map((v) => `${namespacePrefix}${v}`));
        violatingTag = targetValues.find((v) => !allowed.has(v));
      } else if (rule.deny !== undefined) {
        const denied = new Set(rule.deny.map((v) => `${namespacePrefix}${v}`));
        violatingTag = targetValues.find((v) => denied.has(v));
      }
      if (violatingTag === undefined) return;
      if (focus !== undefined && edge.fromFile !== focus) return; // evaluated (coverage counted above); not built for a scoped run

      const pointers = rule.deny === undefined
        ? [{ pointer: `edges.allowDeny[${i}].allow`, role: "fired" as const }]
        : [
          { pointer: `edges.allowDeny[${i}].deny[${rule.deny.indexOf(violatingTag.slice(namespacePrefix.length))}]`, role: "fired" as const },
          { pointer: `edges.allowDeny[${i}].allow`, role: "edit-here" as const },
        ];
      const violation: ConstraintViolation = withPointerSpecs({
        rule: "tag-boundary",
        path: edge.fromFile,
        line: edge.fromPosition.line,
        column: edge.fromPosition.column,
        evidence: `'${edge.specifier}' (from '${rule.source}') reaches '${violatingTag}'`,
        because: rule.because,
        do: `remove this edge, or add '${violatingTag.slice(namespacePrefix.length)}' to '${rule.source}'s allow list in archstrict.config.ts and record why`,
        todoModule: edge.fromModule,
      }, pointers);
      violations.push(violation);
      matches.push({ violation, edge, ruleIndex: i, violatingTag });
    });
  }

  const coverage = rules.map((rule, i) => ({
    kind: "allowDeny" as const,
    identifier: `${rule.source} -> ${rule.targetNamespace}`,
    evaluated: evaluatedCounts[i]!,
  }));
  return { violations, coverage, matches };
}

export function targetTagsInGraph(graph: ModuleGraph, config: Config): Set<string> {
  const tags = new Set<string>();
  for (const edge of graph.edges) {
    for (const tag of tagsForTarget(edge, config, graph.relativePath)) tags.add(tag);
  }
  return tags;
}

// Use the whole graph: a value reached only by another source still gives
// this rule something to forbid if its source later imports that value.
// Looking only at the source's current edges would mistake a healthy rule
// for an exhaustive list whenever those edges happen to obey it.
// Exclude the source tag itself: computeAllowDeny exempts targets carrying
// that tag, so this value cannot be a violation candidate for this rule.
// exceptions, edgeType, and importForm select edges to judge, not values
// that exist. An out-of-list value prevents exhaustiveness even when only
// exempted, type-only, or dynamic edges currently reach it.
// Apply this check only to allow lists. A deny list can legitimately name
// a value that does not exist yet to guard against a future regression.
export function checkExhaustiveAllow(graph: ModuleGraph, config: Config): { identifier: string; rule: AllowDenyRule; ruleId: "exhaustive-allow-list" }[] {
  const rules = config.edges?.allowDeny ?? [];
  if (!rules.some(rule => rule.allow !== undefined)) return [];
  const { coverage } = computeAllowDeny(graph, config);
  const allTargetTags = targetTagsInGraph(graph, config);
  return rules.flatMap((rule, i) => {
    if (rule.allow === undefined || coverage[i]!.evaluated === 0) return [];
    const prefix = `${rule.targetNamespace}:`;
    const universe = [...allTargetTags].filter(tag => tag.startsWith(prefix) && tag !== rule.source);
    const allowed = new Set(rule.allow.map(value => `${prefix}${value}`));
    return universe.length > 0 && universe.every(tag => allowed.has(tag))
      ? [{ identifier: coverage[i]!.identifier, rule, ruleId: "exhaustive-allow-list" as const }] : [];
  });
}

export function checkAllowDeny(graph: ModuleGraph, config: Config, focus?: string): ConstraintViolation[] {
  return computeAllowDeny(graph, config, focus).matches.map(match => {
    const moves = computeMoves(match.violation, graph, config, match);
    return moves?.length ? Object.assign(match.violation, { moves }) : match.violation;
  }).sort(byPosition);
}

// Two different things, confirmed distinct by running against Prisma's own
// real config: a `within` value absent from `sequence` ENTIRELY (e.g.
// Prisma's own layerOrder has no "targets" or "extensions" entry at all -
// those domains simply have no internal layering declared) is not this
// rule's concern for that domain - silently out of scope, not an error.
// A `within` value that DOES have a sequence, but doesn't list this
// specific layer value, is the real config error: classify assigned a
// value the config's author forgot to place.
export function sequenceFor(rule: OrderRule, withinValue: string | undefined): readonly string[] | undefined {
  return rule.sequence[withinValue ?? ""];
}

export function assertSequenceListsValue(
  rule: OrderRule,
  withinValue: string | undefined,
  sequence: readonly string[],
  tag: string,
): void {
  const value = tag.slice(rule.tagNamespace.length + 1);
  if (!sequence.includes(value)) {
    throw new ReportError(
      `order rule for '${rule.tagNamespace}' (within '${withinValue ?? "(unscoped)"}') does not list '${value}' - every value classify assigns within that scope must appear in its sequence`,
      `add '${value}' to that order rule's sequence in archstrict.config.ts, then run archstrict check`,
    );
  }
}

// See computeAllowDeny's own comment above for `focus`'s meaning here:
// reports at `edge.fromFile` too, and `evaluatedCounts`/coverage stay
// whole-project regardless of it.
function computeOrder(
  graph: ModuleGraph,
  config: Config,
  focus?: string,
): { violations: ConstraintViolation[]; coverage: EdgeRuleCoverage[] } {
  const rules: readonly OrderRule[] = config.edges?.order ?? [];
  const relativePath = graph.relativePath;
  const violations: ConstraintViolation[] = [];
  const evaluatedCounts = rules.map(() => 0);
  if (rules.length === 0) return { violations, coverage: [] };

  for (const edge of graph.edges) {
    const sourceTags = classifyFile(relativePath(edge.fromFile), config);
    const targetTags = tagsForTarget(edge, config, relativePath);

    rules.forEach((rule, i) => {
      if (!matchesEdgeFilters(edge, rule.edgeType, rule.importForm)) return;

      const namespacePrefix = `${rule.tagNamespace}:`;
      const sourceLayer = [...sourceTags].find((t) => t.startsWith(namespacePrefix));
      const targetLayer = [...targetTags].find((t) => t.startsWith(namespacePrefix));
      if (sourceLayer === undefined || targetLayer === undefined) return;

      let withinValue: string | undefined;
      if (rule.within !== undefined) {
        const withinPrefix = `${rule.within}:`;
        const sourceWithin = [...sourceTags].find((t) => t.startsWith(withinPrefix));
        const targetWithin = [...targetTags].find((t) => t.startsWith(withinPrefix));
        if (sourceWithin === undefined || targetWithin === undefined) return;
        if (sourceWithin !== targetWithin) return; // different scope entirely: this order rule doesn't cross it
        withinValue = sourceWithin.slice(withinPrefix.length);
      }

      const sequence = sequenceFor(rule, withinValue);
      if (sequence === undefined) return; // this within-value has no declared sequence at all: out of scope, not an error

      assertSequenceListsValue(rule, withinValue, sequence, sourceLayer);
      assertSequenceListsValue(rule, withinValue, sequence, targetLayer);

      evaluatedCounts[i]!++; // this rule genuinely had a real edge, within a real declared sequence, to judge

      const sourceIndex = sequence.indexOf(sourceLayer.slice(namespacePrefix.length));
      const targetIndex = sequence.indexOf(targetLayer.slice(namespacePrefix.length));

      // "downward-only": a source may depend on its own layer or one
      // closer to the sequence's start (index 0 = innermost/core); reaching
      // a later index moves away from core, which is forbidden. Matches
      // dependency-cruiser's own generator: forbidden iff targetIndex >
      // sourceIndex.
      if (targetIndex <= sourceIndex) return;
      if (focus !== undefined && edge.fromFile !== focus) return; // evaluated (coverage counted above); not built for a scoped run

      violations.push(withPointerSpecs({
        rule: "tag-order",
        path: edge.fromFile,
        line: edge.fromPosition.line,
        column: edge.fromPosition.column,
        evidence: `'${edge.specifier}' reaches '${targetLayer}' from '${sourceLayer}' (${rule.tagNamespace} sequence: ${sequence.join(" -> ")})`,
        because: rule.because,
        do: `move this edge to depend only on '${rule.tagNamespace}' values at or before '${sourceLayer.slice(namespacePrefix.length)}' in archstrict.config.ts's sequence, or restructure the code so it does`,
        todoModule: edge.fromModule,
      }, [{ pointer: `edges.order[${i}].sequence`, role: "fired" }]));
    });
  }

  const coverage = rules.map((rule, i) => ({
    kind: "order" as const,
    identifier: `${rule.tagNamespace}${rule.within !== undefined ? ` within ${rule.within}` : ""}`,
    evaluated: evaluatedCounts[i]!,
  }));
  return { violations, coverage };
}

export function checkOrder(graph: ModuleGraph, config: Config, focus?: string): ConstraintViolation[] {
  return computeOrder(graph, config, focus).violations.sort(byPosition);
}

// Unlike allowDeny/order (which have an "applicable but allowed" middle
// state), a point rule's from/to predicates ARE the whole rule - any edge
// whose from side matches is a real opportunity for this rule to fire,
// whether or not the to side happens to match as well. So "evaluated"
// here means "the from predicate matched a real edge", the strongest
// vacuousness signal point can offer: a from glob/tags that never matches
// anything real is a rule that can never fire, and a to side that never
// matches doesn't make the rule vacuous on its own (it may be correctly
// finding zero forbidden edges among real, matched-from-side candidates).
// See computeAllowDeny's own comment above for `focus`'s meaning here:
// reports at `edge.fromFile` too, and `evaluatedCounts`/coverage stay
// whole-project regardless of it.
function computePoint(
  graph: ModuleGraph,
  config: Config,
  focus?: string,
): { violations: ConstraintViolation[]; coverage: EdgeRuleCoverage[] } {
  const rules: readonly PointRule[] = config.edges?.point ?? [];
  const identifiers = rules.map(
    (rule) => `${formatPredicate(rule.from)} -> ${formatPredicate(rule.to)}`,
  );
  const relativePath = graph.relativePath;
  const violations: ConstraintViolation[] = [];
  const evaluatedCounts = rules.map(() => 0);
  if (rules.length === 0) return { violations, coverage: [] };

  for (const edge of graph.edges) {
    const sourceRel = relativePath(edge.fromFile);
    const sourceTags = classifyFile(sourceRel, config);
    const targetTags = tagsForTarget(edge, config, relativePath);
    const targetRel = targetRelPathForGlob(edge, relativePath);

    rules.forEach((rule, i) => {
      if (!matchesEdgeFilters(edge, rule.edgeType, rule.importForm)) return;
      if (!matchesPredicate(rule.from, sourceRel, sourceTags)) return;
      evaluatedCounts[i]!++;
      if (!matchesPredicate(rule.to, targetRel, targetTags)) return;
      if (focus !== undefined && edge.fromFile !== focus) return; // evaluated (coverage counted above); not built for a scoped run

      violations.push(withPointerSpecs({
        rule: "point-rule",
        path: edge.fromFile,
        line: edge.fromPosition.line,
        column: edge.fromPosition.column,
        evidence: `'${edge.specifier}' matches a forbidden edge`,
        because: rule.because,
        do: `remove this edge, or narrow the point rule '${identifiers[i]}' in archstrict.config.ts if it's too broad`,
        todoModule: edge.fromModule,
      }, [{ pointer: `edges.point[${i}]`, role: "fired" }]));
    });
  }

  const coverage = identifiers.map((identifier, i) => ({
    kind: "point" as const,
    identifier,
    evaluated: evaluatedCounts[i]!,
  }));
  return { violations, coverage };
}

export function checkPoint(graph: ModuleGraph, config: Config, focus?: string): ConstraintViolation[] {
  return computePoint(graph, config, focus).violations.sort(byPosition);
}

export function checkConstraints(graph: ModuleGraph, config: Config): ConstraintViolation[] {
  return [...checkAllowDeny(graph, config), ...checkOrder(graph, config), ...checkPoint(graph, config)];
}

// All configured allowDeny/order/point rules, each with how many real
// edges reached the point where it could have judged one - not just
// whether it violated. checkEmptyRuleSet (rule 4) uses this to flag a
// rule that structurally never applies to anything, the same "a rule
// that checks nothing must not look like a pass" idea rule 4 already
// applies to classify/declaredModules.
export function checkEdgesCoverage(graph: ModuleGraph, config: Config): EdgeRuleCoverage[] {
  return [
    ...computeAllowDeny(graph, config).coverage,
    ...computeOrder(graph, config).coverage,
    ...computePoint(graph, config).coverage,
  ];
}
