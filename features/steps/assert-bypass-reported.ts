import { defineStep, z } from "nukadoko";
import createTwoModuleProject from "./create-two-module-project.js";
import writeBypassingFile from "./write-bypassing-file.js";

// The do: line is what lets an agent fix its own mistake without asking, so
// the step checks it names both files.
export default defineStep({
  description: "Check exited 1 with exactly one public-surface-bypass, on the new file's import line, and its do: names billing's index and the bypassed file.",
  pattern: "check reports one public-surface-bypass violation whose do: line names billing's index",
  args: z.object({
    newFilePath: createTwoModuleProject.returns.shape.newFilePath,
    billingIndex: createTwoModuleProject.returns.shape.billingIndex,
    billingInternal: createTwoModuleProject.returns.shape.billingInternal,
    exitCode: writeBypassingFile.returns.shape.exitCode,
    violations: writeBypassingFile.returns.shape.violations,
    importLine: writeBypassingFile.returns.shape.importLine,
  }),
  from: {
    newFilePath: [createTwoModuleProject, "newFilePath"],
    billingIndex: [createTwoModuleProject, "billingIndex"],
    billingInternal: [createTwoModuleProject, "billingInternal"],
    exitCode: [writeBypassingFile, "exitCode"],
    violations: [writeBypassingFile, "violations"],
    importLine: [writeBypassingFile, "importLine"],
  },
  observe({}, { exitCode, violations }) {
    // check reports a violation by exiting 1; any other exit is read out as it is.
    return { reported: exitCode !== 1 ? `check exited ${exitCode}` : violations.length === 1 ? "one" : String(violations.length) };
  },
  claims: [
    { actual: "reported", compare: "equal", expected: { literal: "one" } },
    { actual: "violations", at: "0.rule", compare: "equal", expected: { literal: "public-surface-bypass" } },
    { actual: "violations", at: "0.path", compare: "equal", expected: { from: "newFilePath" } },
    { actual: "violations", at: "0.line", compare: "equal", expected: { from: "importLine" } },
    { actual: "violations", at: "0.do", compare: "contains-text", expected: { from: "billingIndex" } },
    { actual: "violations", at: "0.do", compare: "contains-text", expected: { from: "billingInternal" } },
  ],
});
