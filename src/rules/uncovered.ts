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
import { toProjectRelativePosix, type ModuleGraph } from "../module-graph.js";

export type Violation = {
  rule: "uncovered-module";
  path: string; // the file itself
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

const BECAUSE = "a file matching no declared module is unchecked, not passing (deptrac's --fail-on-uncovered)";

export function uncoveredViolationFor(file: string, rootDir: string): Violation {
  // `path` stays absolute (a location every other rule's own `path`
  // points at) - only the glob suggested in `do` needs to be
  // project-relative, since that's a value meant to be pasted directly
  // into declaredModules[].glob or exclude, both of which are always
  // project-relative (config.md).
  const rel = toProjectRelativePosix(file, rootDir);
  return {
    rule: "uncovered-module",
    path: file,
    line: 1,
    column: 1,
    evidence: `'${file}' is in scope but matches no declared module`,
    because: BECAUSE,
    do: `add a declaredModules entry covering '${rel}' in archstrict.config.ts, or add it to exclude if it isn't module content`,
  };
}

export function checkUncoveredModules(graph: ModuleGraph): Violation[] {
  return graph.outsideFiles.map((file) => uncoveredViolationFor(file, graph.rootDir));
}
