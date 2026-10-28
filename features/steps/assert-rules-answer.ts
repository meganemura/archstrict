import { defineStep, z } from "nukadoko";
import askRulesForNewFile from "./ask-rules-for-new-file.js";
import createTwoModuleProject from "./create-two-module-project.js";

// The surface list must hold the index file and nothing else from billing;
// invoice.ts appearing there would tell the agent the bypass is allowed.
export default defineStep({
  description: "The new path belongs to orders, and may import billing only through billing's index file.",
  pattern: "the answer names orders as its module and billing's index file as the way into billing",
  args: z.object({
    billingSurface: createTwoModuleProject.returns.shape.billingSurface,
    module: askRulesForNewFile.returns.shape.module,
    importableFrom: askRulesForNewFile.returns.shape.importableFrom,
  }),
  from: {
    billingSurface: [createTwoModuleProject, "billingSurface"],
    module: [askRulesForNewFile, "module"],
    importableFrom: [askRulesForNewFile, "importableFrom"],
  },
  claims: [
    { actual: "module", compare: "equal", expected: { literal: "orders" } },
    {
      actual: "importableFrom",
      each: {
        where: [{ at: "module", compare: "equal", expected: { literal: "billing" } }],
        claims: [{ at: "surfaceFiles", compare: "equal", expected: { from: "billingSurface" } }],
      },
    },
  ],
});
