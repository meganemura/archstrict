import { defineStep, z } from "nukadoko";
import { join } from "node:path";
import createTwoModuleProject from "./create-two-module-project.js";
import writeBypassingFile, { violations } from "./write-bypassing-file.js";

export default defineStep({
  description: "Asserts check exited 1 with exactly one public-surface-bypass on line 1 of the new file, and its do: names billing's index and the bypassed file.",
  pattern: "check reports one public-surface-bypass violation whose do: line names billing's index",
  args: z.object({
    root: z.string(),
    newFile: z.string(),
    billingIndex: z.string(),
    billingInternal: z.string(),
    exitCode: z.number(),
    violations,
  }),
  returns: z.object({}),
  from: {
    root: [createTwoModuleProject, "root"],
    newFile: [createTwoModuleProject, "newFile"],
    billingIndex: [createTwoModuleProject, "billingIndex"],
    billingInternal: [createTwoModuleProject, "billingInternal"],
    exitCode: [writeBypassingFile, "exitCode"],
    violations: [writeBypassingFile, "violations"],
  },
  mutates: false,
  rationale: "The do: line is what lets an agent fix its own mistake without asking, so the step checks it names both files.",
  run({}, { root, newFile, billingIndex, billingInternal, exitCode, violations }) {
    if (exitCode !== 1) throw new Error(`expected check to exit 1, got ${exitCode}`);
    if (violations.length !== 1) throw new Error(`expected one violation, got ${JSON.stringify(violations)}`);
    const [violation] = violations;
    if (violation!.rule !== "public-surface-bypass") throw new Error(`expected public-surface-bypass, got ${violation!.rule}`);
    if (violation!.path !== join(root, newFile) || violation!.line !== 1) throw new Error(`the violation is at ${violation!.path}:${violation!.line}`);
    if (!violation!.do.includes(billingIndex) || !violation!.do.includes(billingInternal)) throw new Error(`the do: line is ${violation!.do}`);
    return {};
  },
});
