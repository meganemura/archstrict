// Responsibility: rule 5, deprecated edges. archstrict.config.ts's
// `deprecated` list records a from/to module edge with a declared `count`
// and a mandatory `because`. The edge's actual count must never increase
// (a real failure); a decrease only prompts updating `count` downward (an
// informational suggestion, not a failure) — tach's deprecated-dependency
// idea (warn, don't forbid) with "must not grow" added on top.
// Boundary: pure predicate over a ModuleGraph and a Config. No I/O, no
// output formatting. Does not suppress rule 1: a deprecated edge that also
// bypasses its target's public surface is still a rule-1 violation —
// deprecated means "shrinking," not "exempt from every other rule."
import { assertDeprecatedModulesExist, type Config } from "../config.js";
import type { ModuleGraph } from "../module-graph.js";

export type Violation = {
  rule: "deprecated-edge-increased";
  path: string; // config.configPath — a relationship between modules, not a single edge's own file
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

// Not a Violation: informational, does not fail `check`. Kept as its own
// type (same shape, different `rule` tag) so a caller cannot mistake one
// for the other by forgetting to check which array it came from.
export type Suggestion = {
  rule: "deprecated-edge-decreased";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

// A deprecated edge's own count is the number of import/export/dynamic-
// import statements between the two named modules — what a reader would
// count by hand — not the number of distinct files involved. import type
// counts (same reasoning as rule 1: it still reaches the target module,
// even for a type alone).
function countEdges(graph: ModuleGraph, from: string, to: string): number {
  return graph.crossModuleEdges.filter((e) => e.fromModule === from && e.toModule === to).length;
}

export function checkDeprecatedEdges(
  graph: ModuleGraph,
  config: Config,
): { violations: Violation[]; suggestions: Suggestion[] } {
  // Validated up front, same reasoning as assertKindPatternsSupported: a
  // config error must not depend on which branch of this function happens
  // to run first.
  assertDeprecatedModulesExist(graph, config);

  const violations: Violation[] = [];
  const suggestions: Suggestion[] = [];

  for (const entry of config.deprecated ?? []) {
    const actual = countEdges(graph, entry.from, entry.to);

    if (actual > entry.count) {
      violations.push({
        rule: "deprecated-edge-increased",
        path: config.configPath,
        line: 1,
        column: 1,
        evidence: `${entry.from} -> ${entry.to}: declared count ${entry.count}, actual ${actual}`,
        because: entry.because,
        do: `reduce ${entry.from} -> ${entry.to} back to ${entry.count} edges, or raise count in archstrict.config.ts and record why the increase was accepted`,
      });
    } else if (actual > 0 && actual < entry.count) {
      // actual === 0 is not reported here at all: the edge is gone
      // entirely, not merely smaller, which is rule 4's more specific
      // "this deprecation is now moot" case (checkEmptyRuleSet), not a
      // count to update.
      suggestions.push({
        rule: "deprecated-edge-decreased",
        path: config.configPath,
        line: 1,
        column: 1,
        evidence: `${entry.from} -> ${entry.to}: declared count ${entry.count}, actual ${actual}`,
        because: entry.because,
        do: `update count to ${actual} for ${entry.from} -> ${entry.to} in archstrict.config.ts`,
      });
    }
  }

  return { violations, suggestions };
}
