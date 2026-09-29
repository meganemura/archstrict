// Responsibility: specify bounded check text and its drill-down commands.
// Boundary: rule evaluation is covered by rule tests; these tests use completed results.
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_DETAIL_LINE_CAP,
  CHECK_RULE_IDS,
  formatConfigPointerLines,
  formatText,
  groupViolations,
  type AnyViolation,
  type CheckResult,
} from "../src/verbs/check.js";
import { parseCheckArgv } from "../src/check-options.js";

const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;

function violation(moduleName: string, rule = "public-surface-bypass"): AnyViolation {
  return {
    rule,
    path: `/project/src/${moduleName}.ts`,
    line: 1,
    column: 1,
    evidence: `evidence ${moduleName}`,
    because: "because",
    do: "archstrict todo",
    todoModule: moduleName,
    config: {
      path: "/project/archstrict.config.ts",
      line: 1,
      column: 1,
      pointer: "declaredModules[0]",
      role: "governs",
    },
  } as AnyViolation;
}

// Unlike `violation` above, `moduleName` can be omitted - a rule that
// reports at the config file (cycle, config-meaning) has no todoModule of
// its own, and groupViolations' "<project>" bucket exists for exactly that.
function groupableViolation(rule: string, moduleName: string | undefined): AnyViolation {
  const label = moduleName ?? "project";
  return {
    rule,
    path: moduleName === undefined ? "/project/archstrict.config.ts" : `/project/src/${moduleName}.ts`,
    line: 1,
    column: 1,
    evidence: `evidence ${label}`,
    because: "because",
    do: "archstrict todo",
    config: {
      path: "/project/archstrict.config.ts",
      line: 1,
      column: 1,
      pointer: "declaredModules[0]",
      role: "governs",
    },
    ...(moduleName === undefined ? {} : { todoModule: moduleName }),
  } as AnyViolation;
}

function result(violations: AnyViolation[], modulesWithoutSurfaceNames: string[] = []): CheckResult {
  return {
    modules: new Set(violations.flatMap((item) => "todoModule" in item ? [item.todoModule] : [])).size,
    modulesWithoutSurface: modulesWithoutSurfaceNames.length,
    modulesWithoutSurfaceNames,
    edges: violations.length,
    outsideFiles: 0,
    nonTsSourceFiles: 0,
    unresolvedSpecifiers: 0,
    unresolvedSpecifierBreakdown: [],
    unsupportedSyntax: 0,
    typeLeaks: 0,
    todo: 0,
    violations,
    suggestions: [],
    edgeRuleCoverage: [],
  };
}

function todoModule(item: AnyViolation): string {
  return "todoModule" in item ? item.todoModule : "<project>";
}

function detailLines(text: string): string[] {
  return text.split("\n").slice(0, text.split("\n").findIndex((line) => line.startsWith("modules: ")));
}

const SINGLE_VIOLATION_BLOCK = [
  "[public-surface-bypass] /project/src/shared.ts:1:1",
  "  evidence shared",
  "  because: because",
  "  config: /project/archstrict.config.ts:1:1 declaredModules[0] (governs)",
  "  do: archstrict todo",
];

describe("bounded check text", () => {
  test("prints every violation when the result has at most 20", () => {
    expect(formatText(result([violation("shared")]))).toBe([
      ...SINGLE_VIOLATION_BLOCK,
      "modules: 1",
      "modules without a public surface: 0",
      "edges: 1",
      "not covered by any declared module: 0",
      "unresolved specifiers: 0",
      "unsupported syntax: 0",
      "type leaks: 0",
      "todo: 0",
      "do: archstrict todo",
      "",
    ].join("\n"));
  });

  test("prints complete examples for seven groups and summarizes the fourteen cut groups by rule", () => {
    const violations = Array.from({ length: 21 }, (_, index) => violation(`m${String(index).padStart(2, "0")}`));
    const examples = violations.slice(0, 7).flatMap((item) => [
      `[public-surface-bypass] module '${todoModule(item)}': 1 violation(s)`,
      "  example:",
      `[public-surface-bypass] ${item.path}:1:1`,
      `  ${item.evidence}`,
      "  because: because",
      "  config: /project/archstrict.config.ts:1:1 declaredModules[0] (governs)",
      "  do: archstrict todo",
      `  do: archstrict check --rule public-surface-bypass --module ${todoModule(item)}`,
    ]);
    expect(formatText(result(violations))).toBe([
      "violations: 21 in 21 groups",
      ...examples,
      "public-surface-bypass: m07 1, m08 1, m09 1, m10 1, m11 1, m12 1, m13 1, m14 1, m15 1, m16 1, m17 1, +3 more",
      "do: archstrict check --rule public-surface-bypass --module m07",
      "modules: 21",
      "modules without a public surface: 0",
      "edges: 21",
      "not covered by any declared module: 0",
      "unresolved specifiers: 0",
      "unsupported syntax: 0",
      "type leaks: 0",
      "todo: 0",
      "do: archstrict todo",
      "",
    ].join("\n"));
  });

  // Sorts by violation count, not alphabetically: a 99-violation group
  // prints ahead of six count-1 groups whose module names sort earlier.
  // Once the cap cuts groups spanning two different rules, the omitted
  // summary prints one line per rule, and the `do:` names the single
  // largest omitted group rather than `--json`.
  test("sorts the largest group first, and summarizes cut groups from two different rules", () => {
    function block(rule: string, moduleName: string, count: number): string[] {
      return [
        `[${rule}] module '${moduleName}': ${count} violation(s)`,
        "  example:",
        `[${rule}] /project/src/${moduleName}.ts:1:1`,
        `  evidence ${moduleName}`,
        "  because: because",
        "  config: /project/archstrict.config.ts:1:1 declaredModules[0] (governs)",
        "  do: archstrict todo",
        `  do: archstrict check --rule ${rule} --module ${moduleName}`,
      ];
    }
    const shownPsb = ["m00", "m01", "m02", "m03", "m04", "m05"];
    const omittedPsb = ["m06", "m07", "m08", "m09"];
    const omittedTypeLeak = ["z10", "z11", "z12"];
    const violations = [
      ...Array.from({ length: 99 }, () => violation("hot", "type-leak")),
      ...shownPsb.map((m) => violation(m)),
      ...omittedPsb.map((m) => violation(m)),
      ...omittedTypeLeak.map((m) => violation(m, "type-leak")),
    ];
    expect(formatText(result(violations))).toBe([
      "violations: 112 in 14 groups",
      ...block("type-leak", "hot", 99),
      ...shownPsb.flatMap((m) => block("public-surface-bypass", m, 1)),
      `public-surface-bypass: ${omittedPsb.map((m) => `${m} 1`).join(", ")}`,
      `type-leak: ${omittedTypeLeak.map((m) => `${m} 1`).join(", ")}`,
      "do: archstrict check --rule public-surface-bypass --module m06",
      "modules: 14",
      "modules without a public surface: 0",
      "edges: 112",
      "not covered by any declared module: 0",
      "unresolved specifiers: 0",
      "unsupported syntax: 0",
      "type leaks: 0",
      "todo: 0",
      "do: archstrict todo",
      "",
    ].join("\n"));
  });

  // 21 identical violations, all in one module, all one rule: a single
  // group. Its own drill-down (`--rule public-surface-bypass --module
  // shared`) would already match every violation shown, so re-running it
  // would print this same text again - `--json` is offered instead, since
  // it never truncates.
  test("lists a single group's own violations directly, without a circular drill-down, and cites the surface reference", () => {
    const violations = Array.from({ length: 21 }, () => violation("shared"));
    expect(formatText(result(violations, ["shared"]))).toBe([
      "violations: 21 in 1 group",
      "note: 21 of 21 public-surface-bypass violations target modules without a public surface",
      "do: archstrict todo # freeze them for now",
      "do: archstrict recommend --json # read surfaceProposals for a ranked surface per module, from its own real importers",
      ...Array.from({ length: 10 }, () => SINGLE_VIOLATION_BLOCK).flat(),
      "violations omitted: 11",
      "do: archstrict check --rule public-surface-bypass --module shared --json",
      "modules: 1",
      "modules without a public surface: 1",
      "edges: 21",
      "not covered by any declared module: 0",
      "unresolved specifiers: 0",
      "unsupported syntax: 0",
      "type leaks: 0",
      "todo: 0",
      "do: archstrict todo",
      "",
    ].join("\n"));
  });

  test("generated violations group exactly once each, stay within the line cap as text, and print only parseable do: commands", () => {
    const modulePool = ["m0", "m1", "m2", "m3", "m4"];
    const elementGen = gen.record({
      rule: gen.sampledFrom(CHECK_RULE_IDS),
      moduleName: gen.optional(gen.sampledFrom(modulePool)),
    }).map(({ rule, moduleName }) => groupableViolation(rule, moduleName ?? undefined));

    hegel.test((tc) => {
      const violations = tc.draw(gen.arrays(elementGen, { minSize: 21, maxSize: 400 }));

      // Assert the grouping itself, not the printed text: once a group's own
      // line is cut by the cap, "every violation counted in exactly one
      // group" can no longer be read back out of the text alone.
      const groups = groupViolations(violations);
      expect(groups.reduce((sum, group) => sum + group.violations.length, 0)).toBe(violations.length);
      for (const group of groups) {
        for (const v of group.violations) {
          expect(v.rule).toBe(group.rule);
          expect(todoModule(v)).toBe(group.moduleName);
        }
      }

      const text = formatText(result(violations));
      const details = detailLines(text);
      expect(details.length).toBeLessThanOrEqual(CHECK_DETAIL_LINE_CAP);

      for (const line of details.filter((item) => item.trimStart().startsWith("do: archstrict check"))) {
        const argv = line.trim().slice("do: archstrict ".length).split(" ");
        expect(argv.shift()).toBe("check");
        expect(() => parseCheckArgv(argv)).not.toThrow();
      }
    });
  });
});

function filteredProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-bounded-check-"));
  try {
    for (const name of ["app", "shared", "other"]) mkdirSync(join(root, "src", name), { recursive: true });
    writeFileSync(join(root, "src", "shared", "internal.ts"), "export const shared = 1;\n");
    writeFileSync(join(root, "src", "other", "internal.ts"), "export const other = 1;\n");
    writeFileSync(join(root, "src", "app", "main.ts"), [
      'import { shared } from "../shared/internal.js";',
      'import { other } from "../other/internal.js";',
      "export const value = shared + other;",
    ].join("\n"));
    writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
      declaredModules: ["app", "shared", "other"].map((name) => ({ name, glob: `src/${name}/**` })),
      exclude: ["archstrict.config.ts"],
      because: "test",
    })};\n`);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function failedCli(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync("node", [CLI_PATH, ...args], { cwd: root, encoding: "utf8" }), stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("check filters", () => {
  test("rule and module filters narrow text and JSON, and a filtered empty set exits zero", () => filteredProject((root) => {
    const full = failedCli(root, ["check", "--json"]);
    expect(full.status).toBe(1);
    const fullResult = JSON.parse(full.stdout) as CheckResult;
    expect(fullResult.violations).toHaveLength(2);

    const shared = failedCli(root, ["check", "--module", "shared", "--json"]);
    expect(shared.status).toBe(1);
    expect(JSON.parse(shared.stdout)).toEqual({
      ...fullResult,
      violations: fullResult.violations.filter((item) => todoModule(item) === "shared"),
    });

    const sharedViolation = fullResult.violations.find((item) => todoModule(item) === "shared")!;
    const text = failedCli(root, ["check", "--rule", "public-surface-bypass", "--module", "shared"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toBe([
      `[public-surface-bypass] ${sharedViolation.path}:${sharedViolation.line}:${sharedViolation.column}`,
      `  ${sharedViolation.evidence}`,
      `  because: ${sharedViolation.because}`,
      ...formatConfigPointerLines(sharedViolation.config),
      `  do: ${sharedViolation.do}`,
      // The filtered set is one bypass into a surface-less module - 100% of
      // it, so the note fires on this narrower result too: it reads
      // whatever CheckResult formatText is given, filtered or not.
      "note: 1 of 1 public-surface-bypass violations target modules without a public surface",
      "do: archstrict todo # freeze them for now",
      "do: archstrict recommend --json # read surfaceProposals for a ranked surface per module, from its own real importers",
      "modules: 3",
      "modules without a public surface: 3",
      "edges: 2",
      "not covered by any declared module: 0",
      "unresolved specifiers: 0",
      "unsupported syntax: 0",
      "type leaks: 0",
      "todo: 0",
      "summary: this config freezes today's import graph, not a target architecture; no edges rule is configured yet",
      "do: archstrict recommend",
      "do: archstrict hotspots",
      "do: read node_modules/archstrict/skills/archstrict/references/rearchitect.md",
      "do: archstrict todo",
      "",
    ].join("\n"));

    const empty = failedCli(root, ["check", "--rule", "cycle", "--json"]);
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ ...fullResult, violations: [] });
  }));

  test("unknown filters list every valid value in the error message, with a runnable example do command", () => filteredProject((root) => {
    const rule = failedCli(root, ["check", "--rule", "unknown"]);
    expect(rule).toEqual({
      status: 1,
      stdout: "",
      stderr: `archstrict: unknown rule id 'unknown' - valid rule ids: ${CHECK_RULE_IDS.join(", ")}\ndo: archstrict check --rule ${CHECK_RULE_IDS[0]}\n`,
    });

    const moduleName = failedCli(root, ["check", "--module", "unknown"]);
    expect(moduleName).toEqual({
      status: 1,
      stdout: "",
      stderr: "archstrict: unknown module name 'unknown' - valid module names: app, other, shared\ndo: archstrict check --module app\n",
    });
  }));
});
