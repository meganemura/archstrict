import { defineStep, z } from "nukadoko";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";
import runArchstrictCheck from "./run-archstrict-check.js";

// Compares check's report against counts the setup step took directly off the
// filesystem, not against hardcoded numbers - this stays correct across a
// future nukadoko release with a different file count. init declares one
// module per module directory AND one per loose root .ts file, so the module
// count is moduleDirs.length + rootFileCount, and every one of those files is
// covered - the setup step finds no file outside both, unlike before init's
// own walk covered the loose files too.
export default defineStep({
  description:
    "Check's module, surface-less module, outside-file, and unresolved-specifier counts equal the scratch copy's own file layout, computed independently by the setup step.",
  pattern: "check resolves every specifier, matching the scratch copy's own file layout",
  args: z.object({
    expectedModules: setupNukadokoScratch.returns.shape.expectedModules,
    modulesWithoutIndexTs: setupNukadokoScratch.returns.shape.modulesWithoutIndexTs,
    filesOutsideModules: setupNukadokoScratch.returns.shape.filesOutsideModules,
    expectedUnresolvedSpecifiers: setupNukadokoScratch.returns.shape.expectedUnresolvedSpecifiers,
    modules: runArchstrictCheck.returns.shape.modules,
    modulesWithoutSurface: runArchstrictCheck.returns.shape.modulesWithoutSurface,
    outsideFiles: runArchstrictCheck.returns.shape.outsideFiles,
    unresolvedSpecifiers: runArchstrictCheck.returns.shape.unresolvedSpecifiers,
  }),
  from: {
    expectedModules: [setupNukadokoScratch, "expectedModules"],
    modulesWithoutIndexTs: [setupNukadokoScratch, "modulesWithoutIndexTs"],
    filesOutsideModules: [setupNukadokoScratch, "filesOutsideModules"],
    expectedUnresolvedSpecifiers: [setupNukadokoScratch, "expectedUnresolvedSpecifiers"],
    modules: [runArchstrictCheck, "modules"],
    modulesWithoutSurface: [runArchstrictCheck, "modulesWithoutSurface"],
    outsideFiles: [runArchstrictCheck, "outsideFiles"],
    unresolvedSpecifiers: [runArchstrictCheck, "unresolvedSpecifiers"],
  },
  claims: [
    { actual: "modules", compare: "equal", expected: { from: "expectedModules" } },
    { actual: "modulesWithoutSurface", compare: "equal", expected: { from: "modulesWithoutIndexTs" } },
    { actual: "outsideFiles", compare: "equal", expected: { from: "filesOutsideModules" } },
    { actual: "unresolvedSpecifiers", compare: "equal", expected: { from: "expectedUnresolvedSpecifiers" } },
  ],
});
