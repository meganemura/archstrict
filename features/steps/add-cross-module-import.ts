import { defineStep, z } from "nukadoko";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

export default defineStep({
  description: "Adds one brand-new file with one cross-module import to the scratch copy, into a new module.",
  pattern: "one more cross-module import is added to the scratch copy",
  args: z.object({ root: z.string(), moduleDirs: z.array(z.string()) }),
  returns: z.object({
    addedFile: z.string().describe("the new file's path"),
    fromModule: z.string(),
    toModule: z.string(),
  }),
  from: { root: [setupNukadokoScratch, "root"], moduleDirs: [setupNukadokoScratch, "moduleDirs"] },
  rationale:
    "A brand-new file with a brand-new import is exactly one new edge regardless of how many edges already exist between the same two modules, so this needs no survey of nukadoko's existing import graph to know the edit adds exactly one violation: no module in the scratch copy has a public.ts, so any edge into one is a bypass by definition, and this is a file that imported nothing before.",
  run({}, { root, moduleDirs }) {
    const [fromModule, toModule] = moduleDirs;
    if (fromModule === undefined || toModule === undefined) {
      throw new Error("need at least two module directories to add a cross-module import between");
    }
    const targetDir = join(root, "src", toModule);
    const targetFile = readdirSync(targetDir)
      .filter((name) => name.endsWith(".ts") && statSync(join(targetDir, name)).isFile())
      .sort()
      .at(0);
    if (targetFile === undefined) {
      throw new Error(`module '${toModule}' has no top-level .ts file to import from`);
    }
    const addedFile = join(root, "src", fromModule, "_dogfood-extra-edge.ts");
    writeFileSync(addedFile, `import "../${toModule}/${targetFile}";\n`);
    return { addedFile, fromModule, toModule };
  },
});
