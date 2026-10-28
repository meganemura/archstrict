import { defineStep, z } from "nukadoko";
import createTwoModuleProject from "./create-two-module-project.js";
import { runArchstrictJson } from "./two-module-cli.js";

// Asking before the file exists is the point: the answer has to come from the
// config and the graph, not from the file. So a path rules says exists stops
// the scenario here, before any Then reads the answer.
export default defineStep({
  description: "Runs `archstrict rules <new file> --json` for a file that does not exist yet and keeps its module and the surfaces it may import.",
  pattern: "the agent asks archstrict which rules govern a new file in orders",
  args: z.object({ root: z.string(), newFile: z.string() }),
  returns: z.object({
    module: z.string().nullable().describe("the module the path would belong to"),
    importableFrom: z
      .array(z.object({ module: z.string(), surfaceFiles: z.array(z.string()) }))
      .describe("each other module and the absolute paths of the files the new file may import from it"),
  }),
  from: { root: [createTwoModuleProject, "root"], newFile: [createTwoModuleProject, "newFile"] },
  mutates: false,
  async run({}, { root, newFile }) {
    const { exitCode, json } = await runArchstrictJson(root, ["rules", newFile]);
    if (exitCode !== 0) throw new Error(`archstrict rules exited ${exitCode}: ${JSON.stringify(json)}`);
    const answer = json as { exists: boolean; module: string | null; importableFrom: { module: string; surfaceFiles: string[] }[] };
    if (answer.exists) throw new Error("the new file already existed when rules answered");
    return { module: answer.module, importableFrom: answer.importableFrom };
  },
});
