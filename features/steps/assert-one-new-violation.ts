import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";
import assertCheckIsGreenAfterFreeze from "./assert-check-is-green-after-freeze.js";

export default defineStep({
  description: "Asserts one new violation appears after one new cross-module import, and that todo never adds after its first run.",
  pattern: "check reports exactly one new violation, and the frozen count is unchanged",
  args: z.object({ violations: z.number(), todo: z.number(), previousTodo: z.number() }),
  returns: z.object({}),
  mutates: false,
  from: {
    violations: [runArchstrictCheck, "violations"],
    todo: [runArchstrictCheck, "todo"],
    previousTodo: [assertCheckIsGreenAfterFreeze, "todo"],
  },
  rationale:
    "todo never adds after its first run, even when a new violation appears (the same invariant test/todo.test.ts already covers with a synthetic fixture) - this is the same fact measured against nukadoko's real files instead.",
  run({}, { violations, todo, previousTodo }) {
    if (violations !== 1) throw new Error(`expected exactly 1 new violation, check reported ${violations}`);
    if (todo !== previousTodo) {
      throw new Error(`expected todo to stay at ${previousTodo} (todo never adds after its first run), check reported ${todo}`);
    }
    return {};
  },
});
