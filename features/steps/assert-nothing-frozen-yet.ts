import { defineStep, z } from "nukadoko";
import runArchstrictCheck from "./run-archstrict-check.js";

// init declares one module per directory that holds TypeScript source and one
// per loose TypeScript source file, so every file the first check analyzes
// already belongs to exactly one module: 0 uncovered-module violations, by
// construction. No module here has any public surface of its own, so every
// cross-module edge is rule 1's public-surface-bypass; a strongly-connected
// pair of modules is rule 2's cycle; and a singleton file module exposing
// another module's own internal type is rule 6's type-leak (this project's own
// currently-implemented reading of that rule; see rules.md). A run this fresh
// must report at least one violation, exit 1 for it, and suppress none of them.
export default defineStep({
  description:
    "The first check run froze nothing, and found real violations, every one of them freezable (public-surface-bypass, cycle, or type-leak - the only rules any module here can produce).",
  pattern: "nothing is frozen yet, and every violation is freezable",
  args: z.object({
    violations: runArchstrictCheck.returns.shape.violations,
    todo: runArchstrictCheck.returns.shape.todo,
    exitCode: runArchstrictCheck.returns.shape.exitCode,
    publicSurfaceBypass: runArchstrictCheck.returns.shape.publicSurfaceBypass,
    cycle: runArchstrictCheck.returns.shape.cycle,
    typeLeak: runArchstrictCheck.returns.shape.typeLeak,
  }),
  from: {
    violations: [runArchstrictCheck, "violations"],
    todo: [runArchstrictCheck, "todo"],
    exitCode: [runArchstrictCheck, "exitCode"],
    publicSurfaceBypass: [runArchstrictCheck, "publicSurfaceBypass"],
    cycle: [runArchstrictCheck, "cycle"],
    typeLeak: [runArchstrictCheck, "typeLeak"],
  },
  observe({}, { exitCode, publicSurfaceBypass, cycle, typeLeak }) {
    // A run with no violation, or one that did not exit 1 for them, has
    // nothing to freeze, so the count is not read as one.
    const freezable = publicSurfaceBypass + cycle + typeLeak;
    if (freezable === 0) return { freezable: "no freezable violation" };
    if (exitCode !== 1) return { freezable: `check exited ${exitCode}` };
    return { freezable };
  },
  claims: [
    { actual: "todo", compare: "equal", expected: { literal: 0 } },
    { actual: "freezable", compare: "equal", expected: { from: "violations" } },
  ],
});
