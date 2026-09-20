import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export default defineStep({
  description: "Runs the built archstrict CLI's todo verb against the scratch copy.",
  pattern: "archstrict todo runs against the scratch copy",
  args: z.object({ root: z.string() }),
  returns: z.object({
    firstRun: z.boolean(),
    added: z.number(),
    pruned: z.number(),
  }),
  from: { root: [setupNukadokoScratch, "root"] },
  rationale:
    "archstrict todo --json prints TodoResult's own shape directly, so firstRun/added/pruned are read as real data here, not inferred from which of two possible text lines matched.",
  run({}, { root }) {
    const stdout = execFileSync(process.execPath, [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout);
  },
});
