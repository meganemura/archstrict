import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";

export default defineStep({
  description: "Asserts the first check run found real violations and froze none of them yet.",
  pattern: "nothing is frozen yet, and every violation is a public-surface bypass",
  args: z.object({ violations: z.number(), todo: z.number(), exitCode: z.number() }),
  returns: z.object({ violations: z.number().describe("carried forward so a later step can assert the frozen count matches it exactly") }),
  mutates: false,
  from: {
    violations: [runArchstrictCheck, "violations"],
    todo: [runArchstrictCheck, "todo"],
    exitCode: [runArchstrictCheck, "exitCode"],
  },
  rationale:
    "No module in the scratch copy that lacks an index.ts has any public surface, so every cross-module edge into one is rule 1's public-surface-bypass by definition; a run this fresh must report at least one and suppress none of them.",
  run({}, { violations, todo, exitCode }) {
    if (violations === 0) throw new Error("expected at least one violation on a fresh, unfrozen scratch copy");
    if (todo !== 0) throw new Error(`expected todo: 0 before archstrict todo ever ran, got ${todo}`);
    if (exitCode !== 1) throw new Error(`expected exit code 1 with violations present, got ${exitCode}`);
    return { violations };
  },
});
