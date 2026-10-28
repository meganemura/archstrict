import { defineStep, z } from "nukadoko";
import runArchstrictCheckAgain from "./run-archstrict-check-again.js";
import runArchstrictTodo from "./run-archstrict-todo.js";

// todo never adds after its first run, even when a new violation appears (the
// same invariant test/todo.test.ts already covers with a synthetic fixture) -
// this is the same fact measured against nukadoko's real files instead.
export default defineStep({
  description: "One new violation appears after one new cross-module import, and check's frozen count is still what todo froze.",
  pattern: "check reports exactly one new violation, and the frozen count is unchanged",
  args: z.object({
    violations: runArchstrictCheckAgain.returns.shape.violations,
    todo: runArchstrictCheckAgain.returns.shape.todo,
    frozen: runArchstrictTodo.returns.shape.added,
  }),
  from: {
    violations: [runArchstrictCheckAgain, "violations"],
    todo: [runArchstrictCheckAgain, "todo"],
    frozen: [runArchstrictTodo, "added"],
  },
  observe({}, { violations }) {
    return { newViolations: violations === 1 ? "one" : String(violations) };
  },
  claims: [
    { actual: "newViolations", compare: "equal", expected: { literal: "one" } },
    { actual: "todo", compare: "equal", expected: { from: "frozen" } },
  ],
});
