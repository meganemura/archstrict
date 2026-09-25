import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import setupNukadokoScratch from "./setup-nukadoko-scratch.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

type ExecError = { status: number | null; stdout: string };

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
  rationale:
    "check's own JSON shape is the contract to verify (the ticket asks for real files and JSON output), so this spawns the real CLI with --json rather than calling check() in-process, matching cli.test.ts's own pattern. execFileSync throws on a nonzero exit (check exits 1 whenever violations exist, by design), so a nonzero exit is caught and read as data instead of letting the step fail on the expected case.",
  run({}, { root }) {
    let stdout: string;
    let exitCode: number;
    try {
      stdout = execFileSync(process.execPath, [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      exitCode = 0;
    } catch (error) {
      const execError = error as ExecError;
      stdout = execError.stdout;
      exitCode = execError.status ?? 1;
    }
    const parsed = JSON.parse(stdout);
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
