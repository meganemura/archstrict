import { defineStep, z } from "nukadoko";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import createTwoModuleProject from "./create-two-module-project.js";
import { runCheck } from "./two-module-cli.js";

export const violations = z
  .array(z.object({ rule: z.string(), path: z.string(), line: z.number(), do: z.string() }))
  .describe("each violation check reported: its rule id, absolute path, line, and do: command");

// Writing and checking are one step because check is what an agent's edit hook
// runs right after the write.
export default defineStep({
  description: "Writes src/orders/checkout.ts importing roundCents from billing's invoice.ts, then runs `archstrict check --json`.",
  pattern: "the agent writes that file with an import of a billing file other than its index",
  args: z.object({ root: z.string(), newFile: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("check's exit code: 1 when a violation is reported"),
    violations,
    importLine: z.number().describe("the line of the new file that holds the import of billing's invoice.ts"),
  }),
  from: { root: [createTwoModuleProject, "root"], newFile: [createTwoModuleProject, "newFile"] },
  mutates: true,
  async run({}, { root, newFile }) {
    const text = 'import { roundCents } from "../billing/invoice.ts";\n\nexport function checkoutTotal(value: number): number {\n  return roundCents(value);\n}\n';
    writeFileSync(join(root, newFile), text);
    const importLine = text.split("\n").findIndex((line) => line.includes("../billing/invoice.ts")) + 1;
    return { ...(await runCheck(root)), importLine };
  },
});
