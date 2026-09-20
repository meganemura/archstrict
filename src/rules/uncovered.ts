// Responsibility: rule 3, uncovered files (deptrac's --fail-on-uncovered,
// generalized to v1's file-glob model). A real, in-scope file matching no
// declared module fails the check - the implementation of the project's
// own rule that a zero must never look like success when it is really an
// omission (a check that silently skipped a file must not look like that
// file passed). Under v0's directory-based discovery this was "a module
// no kind names"; under v1's glob-based declaredModules, the same idea is
// simpler and needs no pattern-matching of its own: module-graph.ts's own
// `outsideFiles` already tracks exactly this (a file in scope, matching no
// declared module) - this rule only reports it as a violation, one per
// file, instead of silence.
// Boundary: pure predicate over a ModuleGraph. No I/O, no output formatting.
import type { ModuleGraph } from "../module-graph.js";

export type Violation = {
  rule: "uncovered-module";
  path: string; // the file itself
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
};

const BECAUSE = "a file matching no declared module is unchecked, not passing (deptrac's --fail-on-uncovered)";

export function checkUncoveredModules(graph: ModuleGraph): Violation[] {
  return graph.outsideFiles.map((file) => ({
    rule: "uncovered-module",
    path: file,
    line: 1,
    column: 1,
    evidence: `'${file}' is in scope but matches no declared module`,
    because: BECAUSE,
    next: `add a declaredModules entry covering '${file}' in archstrict.config.ts, or add it to exclude if it isn't module content`,
  }));
}
