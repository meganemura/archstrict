// Responsibility: rule 4, the empty rule set (ArchUnitTS's Empty Test
// Protection). A configured rule that matches zero real things must not
// look like a pass — the same "a zero can look like success when it is
// really an omission" principle as rule 3, from the other direction: rule
// 3 is "a file no declared module covers is a failure"; this is "a
// declaration (a module, or a classify glob) that covers no real file is
// a failure". Also reports allow lists that cover every real target value.
// Boundary: a config-vs-graph consistency check, not an edge check. No
// I/O, no output formatting.
import { assertDeprecatedModulesExist, type Config } from "../config.js";
import { compileGlob } from "../classify.js";
import { type ModuleGraph } from "../module-graph.js";
import { checkEdgesCoverage, checkExhaustiveAllow } from "./constraints.js";
import { withPointerSpecs } from "../config-pointer.js";

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

  // Every classify glob must match at least one real, in-scope file - the
  // classification-layer's own version of "a kind that matches no
  // module": a glob that matches nothing is a config typo or a stale
  // entry, either way a rule that checks nothing must not look like a
  // pass.
  const allFiles = [...graph.modules.values()].flatMap((m) => m.files).concat(graph.outsideFiles);
  for (const [entryIndex, entry] of (config.classify ?? []).entries()) {
    const glob = compileGlob(entry.glob);
    const matchesAny = allFiles.some((file) => glob.test(graph.relativePath(file)));
    if (!matchesAny) {
      violations.push(
        violation(
          config,
          `classify glob '${entry.glob}' matches no file in scope`,
          `remove this classify entry from archstrict.config.ts, or point its glob at real files`,
          `classify[${entryIndex}]`,
        ),
      );
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
  // control, which these checks cannot replace.
  const coverageIndices = { allowDeny: 0, order: 0, point: 0 };
  for (const c of checkEdgesCoverage(graph, config)) {
    const entryIndex = coverageIndices[c.kind]++;
    if (c.evaluated === 0) {
      violations.push(
        violation(
          config,
          `${c.kind} rule '${c.identifier}' matches no real edge in scope`,
          `remove or correct this ${c.kind} entry in archstrict.config.ts's edges - its own source/target never applies to any real edge this project has (a workspace-sibling import may resolve as an external package rather than a project tag; see rules.md)`,
          `edges.${c.kind}[${entryIndex}]`,
        ),
      );
    }
  }

  for (const { identifier, rule } of checkExhaustiveAllow(graph, config)) {
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
