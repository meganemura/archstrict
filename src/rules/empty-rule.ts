// Responsibility: rule 4, the empty rule set (ArchUnitTS's Empty Test
// Protection). A configured rule that matches zero real things must not
// look like a pass — the same "a zero can look like success when it is
// really an omission" principle as rule 3, from the other direction: rule
// 3 is "a file no declared module covers is a failure"; this is "a
// declaration (a module, or a classify glob) that covers no real file is
// a failure".
// Boundary: a config-vs-graph consistency check, not an edge check. No
// I/O, no output formatting.
import { assertDeprecatedModulesExist, type Config } from "../config.js";
import { compileGlob } from "../classify.js";
import { toProjectRelativePosix, type ModuleGraph } from "../module-graph.js";
import { checkEdgesCoverage } from "./constraints.js";

export type Violation = {
  rule: "empty-rule-set";
  path: string; // config.configPath — this is a config-vs-graph check, not an edge check
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
};

const BECAUSE =
  "a rule that checks nothing must not look like a pass (ArchUnitTS's Empty Test Protection)";

function violation(config: Config, evidence: string, next: string): Violation {
  return {
    rule: "empty-rule-set",
    path: config.configPath,
    line: 1,
    column: 1,
    evidence,
    because: BECAUSE,
    next,
  };
}

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
  for (const entry of config.classify ?? []) {
    const glob = compileGlob(entry.glob);
    const matchesAny = allFiles.some((file) => glob.test(toProjectRelativePosix(file, graph.rootDir)));
    if (!matchesAny) {
      violations.push(
        violation(
          config,
          `classify glob '${entry.glob}' matches no file in scope`,
          `remove this classify entry from archstrict.config.ts, or point its glob at real files`,
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
  for (const entry of config.deprecated ?? []) {
    const actual = graph.crossModuleEdges.filter(
      (e) => e.fromModule === entry.from && e.toModule === entry.to,
    ).length;
    if (actual === 0) {
      violations.push(
        violation(
          config,
          `deprecated edge '${entry.from} -> ${entry.to}' (declared count ${entry.count}) no longer exists`,
          `remove the '${entry.from} -> ${entry.to}' entry from deprecated in archstrict.config.ts`,
        ),
      );
    }
  }

  // An allowDeny/order/point rule whose own source/target combination
  // never applies to any real edge in the graph is the constraint
  // engine's own version of the same idea: a rule that structurally
  // cannot fire must not look like a clean pass. This only catches the
  // zero case - a rule that evaluates real edges and genuinely finds
  // nothing forbidden reads as a real, meaningful pass, not a violation
  // (and rules.md documents why a nonzero "clean" result still deserves a
  // positive-control check before it's trusted, which this rule cannot
  // substitute for).
  for (const c of checkEdgesCoverage(graph, config)) {
    if (c.evaluated === 0) {
      violations.push(
        violation(
          config,
          `${c.kind} rule '${c.identifier}' matches no real edge in scope`,
          `remove or correct this ${c.kind} entry in archstrict.config.ts's edges - its own source/target never applies to any real edge this project has (a workspace-sibling import may resolve as an external package rather than a project tag; see rules.md)`,
        ),
      );
    }
  }

  return violations;
}
