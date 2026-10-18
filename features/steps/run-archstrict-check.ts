import { defineStep, runCommand, z } from "nukadoko";
import { fileURLToPath } from "node:url";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

// The scenario requires real files and the CLI's JSON output, so this spawns
// the real CLI with --json rather than calling check() in-process, matching
// cli.test.ts's own pattern. check exits 1 whenever violations exist, by
// design, so the exit code is read as data instead of failing the step on
// the expected case.
export default defineStep({
  description: "Runs the built archstrict CLI's check verb against the scratch copy and parses its --json output.",
  patterns: ["archstrict check runs against the scratch copy", "archstrict check runs against the scratch copy again"],
  args: z.object({ root: z.string() }),
  returns: z.object({
    modules: z.number(),
    modulesWithoutSurface: z.number(),
    edges: z.number(),
    outsideFiles: z.number(),
    unresolvedSpecifiers: z.number(),
    unsupportedSyntax: z.number(),
    todo: z.number(),
    violations: z.number().describe("count of result.violations, not the array itself"),
    uncoveredModule: z.number().describe("count of result.violations whose rule is uncovered-module - these have no owning module directory, so todo can never freeze them"),
    publicSurfaceBypass: z.number().describe("count of result.violations whose rule is public-surface-bypass"),
    cycle: z.number().describe("count of result.violations whose rule is cycle"),
    typeLeak: z.number().describe("count of result.violations whose rule is type-leak"),
    exitCode: z.number(),
  }),
  from: { root: [setupNukadokoScratch, "root"] },
  async run({}, { root }) {
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
  },
});
