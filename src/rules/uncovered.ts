// Responsibility: rule 3, uncovered modules (deptrac's --fail-on-uncovered).
// A module that matches no kind in the config fails the check — the
// implementation of the project's own rule that a zero must never look
// like success when it is really an omission (a check that silently
// skipped a module must not look like that module passed).
// Boundary: pure predicate over a ModuleGraph and a Config. No I/O, no
// output formatting.
import { assertKindPatternsSupported, kindPatternNames, type Config } from "../config.js";
import type { ModuleGraph } from "../module-graph.js";

export type Violation = {
  rule: "uncovered-module";
  path: string; // the module's directory
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
};

const BECAUSE =
  "a module matching no kind is unchecked, not passing (deptrac's --fail-on-uncovered)";

export function checkUncoveredModules(graph: ModuleGraph, config: Config): Violation[] {
  // Validated up front, independent of graph.modules: an unsupported
  // pattern shape is unsupported whether or not the loop below ever
  // reaches a module that would have exposed it.
  assertKindPatternsSupported(config);

  const violations: Violation[] = [];

  for (const [name, module] of graph.modules) {
    const matchingKinds = Object.entries(config.kinds).filter(
      ([, pattern]) => kindPatternNames(pattern, config.modules, name) === true,
    );

    if (matchingKinds.length > 1) {
      throw new Error(
        `module '${name}' matches more than one kind (${matchingKinds.map(([k]) => k).join(", ")}); ` +
          `kinds must not overlap`,
      );
    }

    if (matchingKinds.length === 0) {
      violations.push({
        rule: "uncovered-module",
        path: module.dir,
        line: 1,
        column: 1,
        evidence: `module '${name}' matches no kind in ${JSON.stringify(config.kinds)}`,
        because: BECAUSE,
        next: `add '${name}' to an existing kind's pattern, or give it its own kind in archstrict.config.ts`,
      });
    }
  }

  return violations;
}
