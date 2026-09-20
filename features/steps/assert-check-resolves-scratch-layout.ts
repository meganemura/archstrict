import { defineStep, z } from "nukadoko";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";
import runArchstrictCheck from "./run-archstrict-check.js";

export default defineStep({
  description:
    "Asserts check's module/outside-file/unresolved-specifier counts against the scratch copy's own file layout, computed independently by the setup step.",
  pattern: "check resolves every specifier, matching the scratch copy's own file layout",
  args: z.object({
    moduleDirs: z.array(z.string()),
    rootFileCount: z.number(),
    modulesWithoutIndexTs: z.number(),
    expectedUnresolvedSpecifiers: z.number(),
    modules: z.number(),
    modulesWithoutSurface: z.number(),
    outsideFiles: z.number(),
    unresolvedSpecifiers: z.number(),
  }),
  returns: z.object({}),
  mutates: false,
  from: {
    moduleDirs: [setupNukadokoScratch, "moduleDirs"],
    rootFileCount: [setupNukadokoScratch, "rootFileCount"],
    modulesWithoutIndexTs: [setupNukadokoScratch, "modulesWithoutIndexTs"],
    expectedUnresolvedSpecifiers: [setupNukadokoScratch, "expectedUnresolvedSpecifiers"],
    modules: [runArchstrictCheck, "modules"],
    modulesWithoutSurface: [runArchstrictCheck, "modulesWithoutSurface"],
    outsideFiles: [runArchstrictCheck, "outsideFiles"],
    unresolvedSpecifiers: [runArchstrictCheck, "unresolvedSpecifiers"],
  },
  rationale:
    "Compares check's report against counts the setup step took directly off the filesystem, not against hardcoded numbers - this stays correct across a future nukadoko release with a different file count.",
  run({}, args) {
    if (args.modules !== args.moduleDirs.length) {
      throw new Error(`expected ${args.moduleDirs.length} modules, check reported ${args.modules}`);
    }
    if (args.modulesWithoutSurface !== args.modulesWithoutIndexTs) {
      throw new Error(
        `expected ${args.modulesWithoutIndexTs} modules without a surface (no index.ts), check reported ${args.modulesWithoutSurface}`,
      );
    }
    if (args.outsideFiles !== args.rootFileCount) {
      throw new Error(`expected ${args.rootFileCount} files not covered by any declared module, check reported ${args.outsideFiles}`);
    }
    if (args.unresolvedSpecifiers !== args.expectedUnresolvedSpecifiers) {
      throw new Error(
        `expected ${args.expectedUnresolvedSpecifiers} unresolved specifiers (bare specifiers naming neither a node builtin nor an installed package), check reported ${args.unresolvedSpecifiers}`,
      );
    }
    return {};
  },
});
