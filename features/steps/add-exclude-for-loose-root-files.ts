import { defineStep, z } from "nukadoko";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

export default defineStep({
  description:
    "Extends the generated config's exclude list to also cover the loose .ts files directly under src/ (outside every declared module) - the same choice a project owner has to make onboarding a real, unconventional codebase: declare a module for a file, or say it isn't module content.",
  pattern: "an exclude for the scratch copy's own loose root files is added",
  args: z.object({ root: z.string() }),
  returns: z.object({}),
  from: { root: [setupNukadokoScratch, "root"] },
  rationale:
    "init's own default exclude (['*.ts']) only covers the project root, not files directly under src/ - nukadoko's own real source has several (matching setup-nukadoko-scratch.ts's own rootFileCount), and rule 3 now really flags them (no interim exemption). String-replacing init's exact, known-literal output is simpler than parsing TypeScript, and safe here because this step only ever runs right after init wrote that literal text.",
  run({}, { root }) {
    const configPath = join(root, "archstrict.config.ts");
    const before = readFileSync(configPath, "utf8");
    const needle = `exclude: ["*.ts"],`;
    if (!before.includes(needle)) {
      throw new Error(`expected init's own default exclude line ('${needle}') in ${configPath}`);
    }
    writeFileSync(configPath, before.replace(needle, `exclude: ["*.ts", "src/*.ts"],`));
    return {};
  },
});
