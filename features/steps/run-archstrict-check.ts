import { defineStep, runCommand, z } from "nukadoko";
import { fileURLToPath } from "node:url";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export const checkCounts = z.object({
  modules: z.number().describe("the number of declared modules check analyzed"),
  modulesWithoutSurface: z.number().describe("the number of modules with no public-surface file present"),
  edges: z.number().describe("the number of import edges between analyzed files"),
  outsideFiles: z.number().describe("the number of analyzed files that no declared module covers"),
  unresolvedSpecifiers: z.number().describe("the number of import specifiers that resolve to no file, node builtin, or installed package"),
  unsupportedSyntax: z.number().describe("the number of CommonJS imports (require() and import = require()), which check counts but does not follow"),
  todo: z.number().describe("the number of violations that archstrict.todo.json freezes, which check does not report"),
  violations: z.number().describe("count of result.violations, not the array itself"),
  uncoveredModule: z.number().describe("count of result.violations whose rule is uncovered-module - these have no owning module directory, so todo can never freeze them"),
  publicSurfaceBypass: z.number().describe("count of result.violations whose rule is public-surface-bypass"),
  cycle: z.number().describe("count of result.violations whose rule is cycle"),
  typeLeak: z.number().describe("count of result.violations whose rule is type-leak"),
  exitCode: z.number().describe("check's exit code: 1 when it reports a violation, 0 otherwise"),
});

// The scenario requires real files and the CLI's JSON output, so this spawns
// the real CLI with --json rather than calling check() in-process, matching
// cli.test.ts's own pattern. check exits 1 whenever violations exist, by
// design, so the exit code is read as data instead of failing the step on
// the expected case. check must write nothing, so the step declares
// mutates: false and nukadoko compares that against the files the spawned
// CLI changed under the scratch copy.
export async function checkScratch(root: string): Promise<z.infer<typeof checkCounts>> {
  const result = await runCommand(process.execPath, [CLI_PATH, "check", "--json"], { cwd: root });
  const exitCode = result.exitCode ?? 1;
  const parsed = JSON.parse(result.stdout);
  return {
    modules: parsed.modules,
    modulesWithoutSurface: parsed.modulesWithoutSurface,
    edges: parsed.edges,
    outsideFiles: parsed.outsideFiles,
    unresolvedSpecifiers: parsed.unresolvedSpecifiers,
    unsupportedSyntax: parsed.unsupportedSyntax,
    todo: parsed.todo,
    violations: parsed.violations.length,
    uncoveredModule: parsed.violations.filter((v: { rule: string }) => v.rule === "uncovered-module").length,
    publicSurfaceBypass: parsed.violations.filter((v: { rule: string }) => v.rule === "public-surface-bypass").length,
    cycle: parsed.violations.filter((v: { rule: string }) => v.rule === "cycle").length,
    typeLeak: parsed.violations.filter((v: { rule: string }) => v.rule === "type-leak").length,
    exitCode,
  };
}

// The first check and every later one are two steps over one run, because
// `from` reads the latest result of a step: a Then after a later check still
// reads the first check's counts from this step.
export default defineStep({
  description: "Runs the built archstrict CLI's check verb against the scratch copy for the first time and parses its --json output.",
  pattern: "archstrict check runs against the scratch copy",
  args: z.object({ root: z.string() }),
  mutates: false,
  returns: checkCounts,
  from: { root: [setupNukadokoScratch, "root"] },
  run({}, { root }) {
    return checkScratch(root);
  },
});
