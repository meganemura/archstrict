import { defineStep, z } from "nukadoko";
import followDoLine from "./follow-do-line.js";
import { violations } from "./write-bypassing-file.js";

// A fix that only moves the violation elsewhere would leave one in the list,
// so the list is checked as well as the exit code.
export default defineStep({
  description: "Asserts check exited 0 with no violation after the fix.",
  pattern: "check passes with no violation",
  args: z.object({ exitCode: z.number(), violations }),
  from: { exitCode: [followDoLine, "exitCode"], violations: [followDoLine, "violations"] },
  mutates: false,
  run({}, { exitCode, violations }) {
    if (exitCode !== 0 || violations.length !== 0) throw new Error(`check exited ${exitCode} with ${JSON.stringify(violations)}`);
  },
});
