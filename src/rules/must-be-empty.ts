// Responsibility: config.mustBeEmpty - archspec's own "empty component"
// concept (a directory a team decided must hold no code at all, e.g.
// vanilla_rails's own convention that app/services stays empty when a
// project deliberately keeps rich models instead of service objects).
// Distinct from rule 4 (empty-rule-set): that rule flags a RULE that
// structurally cannot match anything; this one flags a real FILE existing
// where the config says none should. A violation is any file matching the
// glob at all - 0 matches is a clean pass, not silence, the same
// convention every other rule here follows.
// Boundary: pure predicate over a file list and a Config. No I/O of its
// own (the caller supplies which files exist), no output formatting.
import { compileGlob } from "../classify.js";
import type { Config } from "../config.js";
import { withPointerSpecs } from "../config-pointer.js";

export type Violation = {
  rule: "must-be-empty";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

// Reports at `file` (each entry's own path) - independent per file, unlike
// uncovered-module's own grouping/naming: whether one file matches a
// `mustBeEmpty` glob never depends on any other file in `files`. So a
// `check <file>` run's own caller (runRules) can safely narrow `files`
// down to just the focus file before calling this rule at all, and get
// exactly the same result as running the whole list and filtering
// afterward - the narrowing happens in runRules, not in this file.
//
// `files`: every real, project-root-relative (forward-slash) path this
// config's own analysis scope covers - the caller decides what that scope
// is (declared modules' own files, or a project's whole file list); this
// rule only tests each one against every `mustBeEmpty` glob.
export function checkMustBeEmpty(files: readonly string[], config: Pick<Config, "mustBeEmpty">): Violation[] {
  const entries = config.mustBeEmpty ?? [];
  if (entries.length === 0) return [];

  const violations: Violation[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const glob = compileGlob(entry.glob);
    // `files` is not a promise about order (module membership is built
    // walking rootNames order - a directory scan, not a promise about
    // reading order across files) - sorted here so two files matching the
    // same entry come out in a stable order regardless of it.
    for (const file of [...files].sort()) {
      if (!glob.test(file)) continue;
      violations.push(withPointerSpecs({
        rule: "must-be-empty",
        path: file,
        line: 1,
        column: 1,
        evidence: `'${file}' matches '${entry.glob}', which must stay empty`,
        because: entry.because,
        do: `move '${file}' out of '${entry.glob}', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies`,
      }, [{ pointer: `mustBeEmpty[${entryIndex}]`, role: "fired" }]));
    }
  }
  return violations;
}
