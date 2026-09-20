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

export type Violation = {
  rule: "must-be-empty";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
};

// `files`: every real, project-root-relative (forward-slash) path this
// config's own analysis scope covers - the caller decides what that scope
// is (declared modules' own files, or a project's whole file list); this
// rule only tests each one against every `mustBeEmpty` glob.
export function checkMustBeEmpty(files: readonly string[], config: Pick<Config, "mustBeEmpty">): Violation[] {
  const entries = config.mustBeEmpty ?? [];
  if (entries.length === 0) return [];

  const violations: Violation[] = [];
  for (const entry of entries) {
    const glob = compileGlob(entry.glob);
    for (const file of files) {
      if (!glob.test(file)) continue;
      violations.push({
        rule: "must-be-empty",
        path: file,
        line: 1,
        column: 1,
        evidence: `'${file}' matches '${entry.glob}', which must stay empty`,
        because: entry.because,
        next: `move '${file}' out of '${entry.glob}', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies`,
      });
    }
  }
  return violations;
}
