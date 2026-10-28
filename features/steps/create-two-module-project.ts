import { defineStep, z } from "nukadoko";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArchstrictJson } from "./two-module-cli.js";

const NODE_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));

// init writes the config, as it would for a new user, so the scenario checks
// the default posture rather than a config written by hand. roundCents is
// exported by invoice.ts but not by index.ts, which is the bypass an agent
// writes when it imports what it found by search.
export default defineStep({
  description:
    "Writes a scratch project with src/billing (index.ts re-exports invoiceTotal from invoice.ts, which also holds roundCents) and src/orders (index.ts), then runs `archstrict init` to declare one module per directory.",
  pattern: "a project whose billing and orders directories are declared modules by archstrict init",
  args: z.object({}),
  returns: z.object({
    root: z.string().describe("the scratch project's root"),
    billingIndex: z.string().describe("billing's public surface file, relative to the root"),
    billingInternal: z.string().describe("a billing file that is not its surface, relative to the root"),
    newFile: z.string().describe("the orders file the agent is about to create, relative to the root"),
    newFilePath: z.string().describe("the orders file the agent is about to create, as an absolute path"),
    billingSurface: z.array(z.string()).describe("the absolute paths of the files billing shows other modules: its index file alone"),
  }),
  mutates: true,
  async run({ scratch }) {
    const root = scratch.dir("archstrict-rules-scenario");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    mkdirSync(join(root, "src/orders"), { recursive: true });
    symlinkSync(NODE_MODULES, join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "esnext", module: "nodenext", strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true } }),
    );
    writeFileSync(join(root, "src/billing/index.ts"), 'export { invoiceTotal } from "./invoice.ts";\n');
    writeFileSync(
      join(root, "src/billing/invoice.ts"),
      "export function invoiceTotal(lines: number[]): number {\n  return lines.reduce((sum, line) => sum + line, 0);\n}\n\nexport function roundCents(value: number): number {\n  return Math.round(value * 100) / 100;\n}\n",
    );
    writeFileSync(join(root, "src/orders/index.ts"), "export function orderCount(): number {\n  return 0;\n}\n");
    const init = await runArchstrictJson(root, ["init"]);
    if (init.exitCode !== 0) throw new Error(`archstrict init exited ${init.exitCode}: ${JSON.stringify(init.json)}`);
    const billingIndex = "src/billing/index.ts";
    const newFile = "src/orders/checkout.ts";
    return {
      root,
      billingIndex,
      billingInternal: "src/billing/invoice.ts",
      newFile,
      newFilePath: join(root, newFile),
      billingSurface: [join(root, billingIndex)],
    };
  },
});
