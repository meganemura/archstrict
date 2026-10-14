import { defineStep, z } from "nukadoko";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import createTwoModuleProject from "./create-two-module-project.js";
import { runCheck } from "./two-module-cli.js";
import { violations } from "./write-bypassing-file.js";

export default defineStep({
  description: "Adds roundCents to billing's index.ts exports, points the new file's import at billing's index, then runs `archstrict check --json`.",
  pattern: "the agent follows the do: line",
  args: z.object({ root: z.string(), newFile: z.string(), billingIndex: z.string() }),
  returns: z.object({ exitCode: z.number().describe("check's exit code after the fix"), violations }),
  from: { root: [createTwoModuleProject, "root"], newFile: [createTwoModuleProject, "newFile"], billingIndex: [createTwoModuleProject, "billingIndex"] },
  mutates: true,
  rationale: "The do: line says to add the export to the index first if it is missing, and roundCents is missing there, so the fix touches both files.",
  run({}, { root, newFile, billingIndex }) {
    writeFileSync(join(root, billingIndex), 'export { invoiceTotal, roundCents } from "./invoice.ts";\n');
    const path = join(root, newFile);
    writeFileSync(path, readFileSync(path, "utf8").replace('"../billing/invoice.ts"', '"../billing/index.ts"'));
    return runCheck(root);
  },
});
