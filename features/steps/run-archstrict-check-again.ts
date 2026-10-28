import { defineStep, z } from "nukadoko";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";
import { checkCounts, checkScratch } from "./run-archstrict-check.js";

export default defineStep({
  description: "Runs the built archstrict CLI's check verb against the scratch copy again and parses its --json output.",
  pattern: "archstrict check runs against the scratch copy again",
  args: z.object({ root: z.string() }),
  mutates: false,
  returns: checkCounts,
  from: { root: [setupNukadokoScratch, "root"] },
  run({}, { root }) {
    return checkScratch(root);
  },
});
