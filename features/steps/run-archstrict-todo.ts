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
    firstRun: z.boolean().describe("true when this run created archstrict.todo.json and froze the current violations"),
    added: z.number().describe("the number of violations this run froze; 0 on every run after the first"),
    pruned: z.number().describe("the number of frozen entries this run removed because no current violation matches them"),
  }),
  from: { root: [setupNukadokoScratch, "root"] },
  async run({}, { root }) {
    const result = await runCommand(process.execPath, [CLI_PATH, "todo", "--json"], { cwd: root });
    if (result.exitCode !== 0) throw new Error(`archstrict todo exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  },
});
