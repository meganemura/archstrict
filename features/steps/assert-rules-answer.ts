import { defineStep, z } from "nukadoko";
import { join } from "node:path";
import askRulesForNewFile from "./ask-rules-for-new-file.js";
import createTwoModuleProject from "./create-two-module-project.js";

// The surface list must hold the index file and nothing else from billing;
// invoice.ts appearing there would tell the agent the bypass is allowed.
export default defineStep({
  description: "Asserts the path did not exist, belongs to orders, and may import billing only through billing's index file.",
  pattern: "the answer names orders as its module and billing's index file as the way into billing",
  args: z.object({
    root: z.string(),
    billingIndex: z.string(),
    exists: z.boolean(),
    module: z.string().nullable(),
    importableFrom: z.array(z.object({ module: z.string(), surfaceFiles: z.array(z.string()) })),
  }),
  from: {
    root: [createTwoModuleProject, "root"],
    billingIndex: [createTwoModuleProject, "billingIndex"],
    exists: [askRulesForNewFile, "exists"],
    module: [askRulesForNewFile, "module"],
    importableFrom: [askRulesForNewFile, "importableFrom"],
  },
  mutates: false,
  run({}, { root, billingIndex, exists, module, importableFrom }) {
    if (exists) throw new Error("the new file already existed when rules answered");
    if (module !== "orders") throw new Error(`expected module orders, got ${module}`);
    const billing = importableFrom.find((entry) => entry.module === "billing");
    if (billing === undefined) throw new Error(`rules does not name billing: ${JSON.stringify(importableFrom)}`);
    if (JSON.stringify(billing.surfaceFiles) !== JSON.stringify([join(root, billingIndex)])) throw new Error(`billing's surface files are ${JSON.stringify(billing.surfaceFiles)}`);
  },
});
