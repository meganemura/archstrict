import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";

export default defineStep({
  description:
    "Asserts the first check run found real violations, every one of them freezable (public-surface-bypass, cycle, or type-leak - the only rules any module here can produce), and froze none of them yet.",
  pattern: "nothing is frozen yet, and every violation is freezable",
  args: z.object({
    violations: z.number(),
    todo: z.number(),
    exitCode: z.number(),
    uncoveredModule: z.number(),
    publicSurfaceBypass: z.number(),
    cycle: z.number(),
    typeLeak: z.number(),
  }),
  returns: z.object({ violations: z.number().describe("carried forward so a later step can assert the freeze count matches it exactly") }),
  mutates: false,
  from: {
    violations: [runArchstrictCheck, "violations"],
    todo: [runArchstrictCheck, "todo"],
    exitCode: [runArchstrictCheck, "exitCode"],
    uncoveredModule: [runArchstrictCheck, "uncoveredModule"],
    publicSurfaceBypass: [runArchstrictCheck, "publicSurfaceBypass"],
    cycle: [runArchstrictCheck, "cycle"],
    typeLeak: [runArchstrictCheck, "typeLeak"],
  },
  rationale:
    "init declares one module per directory that holds .ts and one per loose .ts file, so every file the first check analyzes already belongs to exactly one module: 0 uncovered-module violations, by construction. No module here has any public surface of its own, so every cross-module edge is rule 1's public-surface-bypass; a strongly-connected pair of modules is rule 2's cycle; and a singleton file module exposing another module's own internal type is rule 6's type-leak (this project's own currently-implemented reading of that rule; see rules.md). A run this fresh must report at least one violation and suppress none of them.",
  run({}, { violations, todo, exitCode, uncoveredModule, publicSurfaceBypass, cycle, typeLeak }) {
    if (violations === 0) throw new Error("expected at least one violation on a fresh, unfrozen scratch copy");
    if (todo !== 0) throw new Error(`expected todo: 0 before archstrict todo ever ran, got ${todo}`);
    if (exitCode !== 1) throw new Error(`expected exit code 1 with violations present, got ${exitCode}`);
    if (uncoveredModule !== 0) throw new Error(`expected 0 uncovered-module violations, check reported ${uncoveredModule}`);
    const freezable = publicSurfaceBypass + cycle + typeLeak;
    if (freezable !== violations) {
      throw new Error(`expected every violation to be public-surface-bypass, cycle, or type-leak (${freezable} of them), check reported ${violations} total`);
    }
    return { violations };
  },
});
