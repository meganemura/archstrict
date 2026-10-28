import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";
import runArchstrictCheckAgain from "./run-archstrict-check-again.js";

// The round trip the spec names: todo then check on unchanged input is always
// green, and the suppressed count must equal exactly what the first run found
// - init's own walk already covers every analyzed file, so there is no
// separate uncovered-module baseline to subtract first.
export default defineStep({
  description: "Check is green after todo freezes every violation the first check run found.",
  pattern: "check is green, with every violation now frozen",
  args: z.object({
    violations: runArchstrictCheckAgain.returns.shape.violations,
    exitCode: runArchstrictCheckAgain.returns.shape.exitCode,
    todo: runArchstrictCheckAgain.returns.shape.todo,
    firstViolations: runArchstrictCheck.returns.shape.violations,
  }),
  from: {
    violations: [runArchstrictCheckAgain, "violations"],
    exitCode: [runArchstrictCheckAgain, "exitCode"],
    todo: [runArchstrictCheckAgain, "todo"],
    firstViolations: [runArchstrictCheck, "violations"],
  },
  observe({}, { violations, exitCode }) {
    return { check: violations === 0 && exitCode === 0 ? "green" : `${violations} violations, exit ${exitCode}` };
  },
  claims: [
    { actual: "check", compare: "equal", expected: { literal: "green" } },
    { actual: "todo", compare: "equal", expected: { from: "firstViolations" } },
  ],
});
