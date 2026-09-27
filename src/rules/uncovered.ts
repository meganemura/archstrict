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
// Boundary: pure predicate over a ModuleGraph. No I/O, no output formatting;
// grouping the uncovered files into one paste-ready declaredModules
// suggestion per directory (or per loose file) is module-candidates.ts's
// job, shared with init's re-run and `archstrict rules <path>` so all three
// print the identical entry text for the same file.
import { toProjectRelativePosix, type ModuleGraph } from "../module-graph.js";
import { groupForRelFile, suggestUncovered, suggestionDoText, type NamedCandidateGroup } from "../module-candidates.js";

export type Violation = {
  rule: "uncovered-module";
  path: string; // the file itself
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

const BECAUSE = "a file matching no declared module is unchecked, not passing";

// `group` is the caller's own suggestion for this file (from
// `suggestUncovered`/`groupForRelFile`) - a bare declaredModules entry with
// no `surface` would make a single-file module entirely private (its
// default surface, index.ts, resolves to a different file), so the do:
// text always carries the file's own name as `surface` for a file group.
export function uncoveredViolationFor(file: string, rootDir: string, group: NamedCandidateGroup): Violation {
  // `path` stays absolute (a location every other rule's own `path`
  // points at) - only the glob suggested in `do` needs to be
  // project-relative, since that's a value meant to be pasted directly
  // into declaredModules[].glob or exclude, both of which are always
  // project-relative (config.md).
  return {
    rule: "uncovered-module",
    path: file,
    line: 1,
    column: 1,
    evidence: `'${file}' is in scope but matches no declared module`,
    because: BECAUSE,
    do: suggestionDoText(group),
  };
}

// Every violation this rule returns is reported at `file` itself - any
// outside file at all, not one fixed path the way config.configPath-only
// rules report - but unlike rule 1's edges, an outside file's own
// naming/grouping (`suggestUncovered`, `nameCandidates`) is NOT
// independent per file: a group's own name can depend on colliding with
// ANOTHER group's on-disk name (module-candidates.ts's own
// `nameCandidates`), computed over every outside file at once. Narrowing
// `relFiles` down to just the focus file before grouping would compute
// that collision check against the wrong, smaller universe and could
// silently pick a different (wrong) name than the unscoped run - so
// `suggestUncovered` still runs over the WHOLE `relFiles` list regardless
// of `focus`, the same full-graph computation checkCycles also keeps.
// `focus`, when given, only skips building a Violation object (and its
// evidence/do strings) for a file whose own path isn't the focus file -
// `file` is already an absolute, real path (module-graph.ts's own
// `outsideFiles`), so it's compared directly, the same invariant rule 1's
// own comment documents.
export function checkUncoveredModules(
  graph: ModuleGraph,
  config: { declaredModules?: readonly { name: string; glob: string }[] },
  focus?: string,
): Violation[] {
  const relFiles = graph.outsideFiles.map((file) => toProjectRelativePosix(file, graph.rootDir));
  const groups = suggestUncovered(relFiles, config.declaredModules ?? []);
  // `graph.outsideFiles` follows the edge build's own walk order (rootNames
  // order - a directory scan, not a promise about reading order across
  // files), not a promise about output order - sorted here by path so
  // this rule's own output stays stable regardless of it.
  return graph.outsideFiles.flatMap((file, i) => {
    if (focus !== undefined && file !== focus) return [];
    const group = groupForRelFile(relFiles[i]!, groups);
    // Every file in `relFiles` was grouped by the same call, so a match
    // always exists - `suggestUncovered` never drops a file it was given.
    return [uncoveredViolationFor(file, graph.rootDir, group!)];
  // Code-unit order (`<`/`>`), not localeCompare: a locale-aware compare
  // can order the same two paths differently on different machines.
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
