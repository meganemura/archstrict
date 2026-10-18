import { defineStep, runCommand, z } from "nukadoko";
import { fileURLToPath } from "node:url";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

// archstrict todo --json prints TodoResult's own shape directly, so
// firstRun/added/pruned are read as real data here, not inferred from which of
// two possible text lines matched.
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
  async run({}, { root }) {
    const result = await runCommand(process.execPath, [CLI_PATH, "todo", "--json"], { cwd: root });
    if (result.exitCode !== 0) throw new Error(`archstrict todo exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  },
});
