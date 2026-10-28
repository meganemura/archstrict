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
import type { Config } from "../config.js";
import type { ModuleGraph } from "../module-graph.js";
import { withPointerSpecs } from "../config-pointer.js";
import { ReportError } from "../report-error.js";

// Throws if any `deprecated` entry names a module that doesn't exist.
// Shared by rule 4 and rule 5: without a single shared check, the two
// rules can disagree about the same config. Measured: rule 4's own
// zero-modules early return skips its `deprecated` loop entirely, so a
// `deprecated` entry naming a nonexistent module reached rule 4's "count
// is 0, edge no longer exists" case instead of a config error — a name
// that never existed is not the same fact as an edge that used to exist
// and shrank to nothing, and reporting it that way is misleading, not
// just imprecise.
export function assertDeprecatedModulesExist(graph: ModuleGraph, config: Config): void {
  for (const entry of config.deprecated ?? []) {
    for (const moduleName of [entry.from, entry.to]) {
      if (!graph.modules.has(moduleName)) {
        throw new ReportError(
          `deprecated entry '${entry.from} -> ${entry.to}' names module '${moduleName}', which does not exist`,
          `declare '${moduleName}' in ${config.configPath}, or remove that deprecated entry, then run archstrict check`,
        );
      }
    }
  }
}

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

// Both `violations` and `suggestions` report at `config.configPath` (a
// declared from/to module pair's own actual count, not a single edge's
// own file) - this rule always runs fully regardless of a `check <file>`
// run's own focus, and `assertDeprecatedModulesExist`'s own validation
// must run every time either way. runRules' own end-of-call filter keeps
// or drops the returned VIOLATIONS depending on whether focus names the
// config file - but never touches `suggestions`, which stays the full,
// whole-project list on every run: `filterToFile` (check.ts) only ever
// narrows `CheckResult.violations`, never `.suggestions`.
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

  // Stryker disable next-line ArrayDeclaration: The placeholder has no numeric count and produces no finding or suggestion.
  for (const [entryIndex, entry] of (config.deprecated ?? []).entries()) {
    const actual = countEdges(graph, entry.from, entry.to);

    if (actual > entry.count) {
      violations.push(withPointerSpecs({
        rule: "deprecated-edge-increased",
        path: config.configPath,
        line: 1,
        column: 1,
        evidence: `${entry.from} -> ${entry.to}: declared count ${entry.count}, actual ${actual}`,
        because: entry.because,
        do: `reduce ${entry.from} -> ${entry.to} back to ${entry.count} edges, or raise count in archstrict.config.ts and record why the increase was accepted`,
      }, [{ pointer: `deprecated[${entryIndex}].count`, role: "fired" }]));
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
