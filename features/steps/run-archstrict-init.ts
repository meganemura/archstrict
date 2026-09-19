import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export default defineStep({
  description: "Runs the built archstrict CLI's init verb against the scratch copy.",
  pattern: "archstrict init runs against the scratch copy",
  args: z.object({ root: z.string() }),
  returns: z.object({ stdout: z.string() }),
  from: { root: [setupNukadokoScratch, "root"] },
  rationale:
    "Spawns the built dist/cli.js as a real process (not the library functions in-process), the same way a person or another agent would invoke archstrict - matching cli.test.ts's own build-then-spawn pattern.",
  run({}, { root }) {
    const stdout = execFileSync(process.execPath, [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
    return { stdout };
  },
});
