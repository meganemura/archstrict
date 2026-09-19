import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";
import assertNothingFrozenYet from "./assert-nothing-frozen-yet.js";

export default defineStep({
  description: "Asserts check is green after todo freezes every violation the first check run found.",
  pattern: "check is green, with every violation now frozen",
  args: z.object({ violations: z.number(), todo: z.number(), exitCode: z.number(), previousViolations: z.number() }),
  returns: z.object({ todo: z.number().describe("carried forward so a later step can assert this count stays unchanged") }),
  mutates: false,
  from: {
    violations: [runArchstrictCheck, "violations"],
    todo: [runArchstrictCheck, "todo"],
    exitCode: [runArchstrictCheck, "exitCode"],
    previousViolations: [assertNothingFrozenYet, "violations"],
  },
  rationale:
    "The round trip the spec names: todo then check on unchanged input is always green, and the suppressed count must equal exactly what the first run found - not merely nonzero.",
  run({}, { violations, todo, exitCode, previousViolations }) {
    if (violations !== 0) throw new Error(`expected 0 violations after freezing, check reported ${violations}`);
    if (exitCode !== 0) throw new Error(`expected exit code 0 once green, got ${exitCode}`);
    if (todo !== previousViolations) {
      throw new Error(`expected todo to equal the ${previousViolations} violation(s) frozen, check reported todo: ${todo}`);
    }
    return { todo };
  },
});
