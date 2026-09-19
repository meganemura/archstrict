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
    "todo has no --json flag (only check does), so its plain-text output is parsed here rather than adding a flag this ticket doesn't ask for; the two possible lines (froze N / pruned N) are mutually exclusive per run, matching todo()'s own firstRun branch.",
  run({}, { root }) {
    const stdout = execFileSync(process.execPath, [CLI_PATH, "todo"], { cwd: root, encoding: "utf8" });
    const froze = /^froze (\d+) violation/m.exec(stdout);
    const pruned = /^pruned (\d+) stale/m.exec(stdout);
    if (froze !== null) return { firstRun: true, added: Number(froze[1]), pruned: 0 };
    if (pruned !== null) return { firstRun: false, added: 0, pruned: Number(pruned[1]) };
    throw new Error(`archstrict todo's output matched neither expected line: ${stdout}`);
  },
});
