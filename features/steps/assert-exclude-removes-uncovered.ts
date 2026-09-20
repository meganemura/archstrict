import { defineStep, z } from "nukadoko";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";
import runArchstrictCheck from "./run-archstrict-check.js";
import assertNothingFrozenYet from "./assert-nothing-frozen-yet.js";

export default defineStep({
  description:
    "Asserts excluding the loose root files removes exactly rootFileCount violations (rule 3's uncovered-module, unfreezable since they own no module directory), leaving only public-surface-bypass behind.",
  pattern: "check reports exactly the loose-file count fewer violations, and every remaining one is a public-surface bypass",
  args: z.object({
    rootFileCount: z.number(),
    previousViolations: z.number(),
    violations: z.number(),
    outsideFiles: z.number(),
    uncoveredModule: z.number(),
  }),
  returns: z.object({ violations: z.number().describe("carried forward as the baseline todo must freeze exactly") }),
  mutates: false,
  from: {
    rootFileCount: [setupNukadokoScratch, "rootFileCount"],
    previousViolations: [assertNothingFrozenYet, "violations"],
    violations: [runArchstrictCheck, "violations"],
    outsideFiles: [runArchstrictCheck, "outsideFiles"],
    uncoveredModule: [runArchstrictCheck, "uncoveredModule"],
  },
  rationale:
    "An uncovered-module violation has no owning module directory, so archstrict todo structurally cannot freeze it away - the round trip's green claim only holds once every in-scope file is either declared or excluded, which this step makes true before todo ever runs.",
  run({}, { rootFileCount, previousViolations, violations, outsideFiles, uncoveredModule }) {
    if (outsideFiles !== 0) throw new Error(`expected 0 files outside every declared module or exclude, check reported ${outsideFiles}`);
    if (uncoveredModule !== 0) throw new Error(`expected 0 uncovered-module violations once excluded, check reported ${uncoveredModule}`);
    const expected = previousViolations - rootFileCount;
    if (violations !== expected) {
      throw new Error(`expected ${expected} violations (${previousViolations} minus the ${rootFileCount} excluded loose files), check reported ${violations}`);
    }
    return { violations };
  },
});
