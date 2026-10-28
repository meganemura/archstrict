import { defineStep, z } from "nukadoko";
import followDoLine from "./follow-do-line.js";

// A fix that only moves the violation elsewhere would leave one in the list,
// so the list is checked as well as the exit code.
export default defineStep({
  description: "Check exited 0 with no violation after the fix.",
  pattern: "check passes with no violation",
  args: z.object({ exitCode: followDoLine.returns.shape.exitCode, violations: followDoLine.returns.shape.violations }),
  from: { exitCode: [followDoLine, "exitCode"], violations: [followDoLine, "violations"] },
  observe({}, { exitCode }) {
    return { check: exitCode === 0 ? "passes" : `exits ${exitCode}` };
  },
  claims: [
    { actual: "check", compare: "equal", expected: { literal: "passes" } },
    { actual: "violations", compare: "equal", expected: { literal: [] } },
  ],
});
