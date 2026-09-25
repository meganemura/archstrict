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
    "Compares check's report against counts the setup step took directly off the filesystem, not against hardcoded numbers - this stays correct across a future nukadoko release with a different file count. init declares one module per module directory AND one per loose root .ts file, so the module count is moduleDirs.length + rootFileCount, and every one of those files is covered - outsideFiles is 0, not rootFileCount, unlike before init's own walk covered the loose files too.",
  run({}, args) {
    const expectedModules = args.moduleDirs.length + args.rootFileCount;
    if (args.modules !== expectedModules) {
      throw new Error(`expected ${expectedModules} modules (${args.moduleDirs.length} directories + ${args.rootFileCount} loose root files), check reported ${args.modules}`);
    }
    if (args.modulesWithoutSurface !== args.modulesWithoutIndexTs) {
      throw new Error(
        `expected ${args.modulesWithoutIndexTs} modules without a surface (no index.ts), check reported ${args.modulesWithoutSurface}`,
      );
    }
    if (args.outsideFiles !== 0) {
      throw new Error(`expected 0 files not covered by any declared module (init's own walk covers every analyzed file by construction), check reported ${args.outsideFiles}`);
    }
    if (args.unresolvedSpecifiers !== args.expectedUnresolvedSpecifiers) {
      throw new Error(
        `expected ${args.expectedUnresolvedSpecifiers} unresolved specifiers (bare specifiers naming neither a node builtin nor an installed package), check reported ${args.unresolvedSpecifiers}`,
      );
    }
    return {};
  },
});
