import { defineStep, z } from "nukadoko";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

// A brand-new file with a brand-new import is exactly one new edge regardless
// of how many edges already exist between the same two modules, so this needs
// no survey of nukadoko's existing import graph to know the edit adds exactly
// one violation: the import names a file other than the target's index.ts,
// so it is a bypass by definition, and this is a file that imported nothing
// before. The edge must not close a cycle, which would be a second violation:
// nukadoko 0.17.0's check/ imports binding/, so binding -> check did. The
// target is therefore a module none of whose files imports past its own
// directory (no "../" specifier), which no new edge into it can put on a
// cycle; that is read off the files, not off archstrict's own graph.
export default defineStep({
  description: "Adds one brand-new file with one cross-module import to the scratch copy, into a new module.",
  pattern: "one more cross-module import is added to the scratch copy",
  args: z.object({ root: z.string(), moduleDirs: z.array(z.string()) }),
  returns: z.object({
    addedFile: z.string().describe("the new file's path"),
    fromModule: z.string().describe("the module directory under src/ that holds the new file"),
    toModule: z.string().describe("the module directory under src/ that the new import reaches into, past its index.ts"),
  }),
  from: { root: [setupNukadokoScratch, "root"], moduleDirs: [setupNukadokoScratch, "moduleDirs"] },
  run({}, { root, moduleDirs }) {
    const tsFilesUnder = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return tsFilesUnder(full);
        return name.endsWith(".ts") ? [full] : [];
      });
    const importsOutward = (moduleDir: string): boolean =>
      tsFilesUnder(join(root, "src", moduleDir)).some((file) => /["']\.\.\//.test(readFileSync(file, "utf8")));
    const toModule = moduleDirs.find((name) => !importsOutward(name));
    const fromModule = moduleDirs.find((name) => name !== toModule);
    if (fromModule === undefined || toModule === undefined) {
      throw new Error("need two module directories, one of which imports nothing past its own directory");
    }
    const targetDir = join(root, "src", toModule);
    const targetFile = readdirSync(targetDir)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts" && statSync(join(targetDir, name)).isFile())
      .sort()
      .at(0);
    if (targetFile === undefined) {
      throw new Error(`module '${toModule}' has no top-level .ts file other than index.ts to import from`);
    }
    const addedFile = join(root, "src", fromModule, "_dogfood-extra-edge.ts");
    writeFileSync(addedFile, `import "../${toModule}/${targetFile}";\n`);
    return { addedFile, fromModule, toModule };
  },
});
