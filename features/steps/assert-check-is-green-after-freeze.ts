import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";
import assertExcludeRemovesUncovered from "./assert-exclude-removes-uncovered.js";

export default defineStep({
  description: "Asserts check is green after todo freezes every violation the (post-exclude) check run found.",
  pattern: "check is green, with every violation now frozen",
  args: z.object({ violations: z.number(), todo: z.number(), exitCode: z.number(), previousViolations: z.number() }),
  returns: z.object({ todo: z.number().describe("carried forward so a later step can assert this count stays unchanged") }),
  mutates: false,
  from: {
    violations: [runArchstrictCheck, "violations"],
    todo: [runArchstrictCheck, "todo"],
    exitCode: [runArchstrictCheck, "exitCode"],
    previousViolations: [assertExcludeRemovesUncovered, "violations"],
  },
  rationale:
    "The round trip the spec names: todo then check on unchanged input is always green, and the suppressed count must equal exactly what the post-exclude run found - not merely nonzero. Every uncovered-module violation was already excluded away by that point (todo can never freeze one; it owns no module directory), so this baseline is the bypass-only count, not the raw first-run count.",
  run({}, { violations, todo, exitCode, previousViolations }) {
    if (violations !== 0) throw new Error(`expected 0 violations after freezing, check reported ${violations}`);
    if (exitCode !== 0) throw new Error(`expected exit code 0 once green, got ${exitCode}`);
    if (todo !== previousViolations) {
      throw new Error(`expected todo to equal the ${previousViolations} violation(s) frozen, check reported todo: ${todo}`);
    }
    return { todo };
  },
});
