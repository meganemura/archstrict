// Responsibility: exercise path planning through real configs and the built CLI.
// Boundary: uses existing violation constructors as the shared reporting contract.
import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rules, formatRulesText } from "../src/verbs/rules.js";
import { checkUncoveredModules, uncoveredViolationFor } from "../src/rules/uncovered.js";
import { checkMustBeEmpty } from "../src/rules/must-be-empty.js";
import { check } from "../src/verbs/check.js";
import type { ModuleGraph } from "../src/module-graph.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const config = {
  declaredModules: [
    { name: "app", glob: "src/app/**", surface: "public/*.ts" },
    { name: "shared", glob: "src/shared/**", surface: "index.ts", friends: [
      { file: "secret.ts", from: "src/app/**", because: "app may use the helper" },
    ] },
    { name: "private", glob: "src/private/**", surface: "index.ts" },
    { name: "future", glob: "src/future/**", surface: "index.ts" },
  ],
  exclude: ["*.ts", "src/app/ignored/**"],
  classify: [{ glob: "src/**", tags: ["z:source", "a:code"] }],
  classifyByDirectoryName: { tagNamespace: "area", names: ["app", "shared"] },
  mustBeEmpty: [{ glob: "src/empty/**", because: "keep this directory empty" }],
  because: "test architecture",
};

async function withProject(fn: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-rules-")));
  try {
    for (const file of ["src/app/main.ts", "src/app/public/api.ts", "src/app/ignored/old.ts",
      "src/app/types.d.ts", "src/shared/index.ts", "src/shared/secret.ts", "src/private/impl.ts", "src/empty/old.ts"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file.endsWith(".d.ts") ? "export declare const value: number;" : "export const value = 1;");
    }
    writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify(config)};`);
    await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [cli, "rules", ...args], { cwd: root, encoding: "utf8" });
}

describe("rules", () => {
  test("reads existing membership and surface files from the graph", async () => withProject(async (root) => {
    const result = await rules(root, join(root, "src/app/public/api.ts"));
    expect(result).toMatchObject({ exists: true, excluded: false, module: "app", isSurfaceFile: true,
      tags: ["a:code", "area:app", "z:source"], uncoveredViolation: undefined, mustBeEmptyViolation: undefined });
    const declaration = await rules(root, join(root, "src/app/types.d.ts"));
    expect(declaration.exists).toBe(true);
    expect(declaration.module).toBeUndefined();
    expect(declaration.isSurfaceFile).toBe(false);
    expect(declaration.uncoveredViolation).toBeUndefined();
    const checked = spawnSync(process.execPath, [cli, "check", "--json"], { cwd: root, encoding: "utf8" });
    expect(checked.status).toBe(1); // The fixture intentionally contains a must-be-empty violation.
    const violations = JSON.parse(checked.stdout).violations as { path: string }[];
    expect(violations.filter((v) => v.path === declaration.path)).toEqual([]);
  }));

  test("existing build outputs and non-source files agree with check's uncovered scope", async () => withProject(async (root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/output.ts"), "export const output = 1;");
    writeFileSync(join(root, "README.md"), "Project notes\n");
    const checked = await check(root);
    for (const file of ["dist/output.ts", "README.md"]) {
      const result = await rules(root, join(root, file));
      expect(result.exists).toBe(true);
      expect(result.module).toBeUndefined();
      expect(result.uncoveredViolation).toBeUndefined();
      expect(checked.violations.filter((v) => v.path === result.path)).toEqual([]);
    }
  }));

  test("uses globs for new files, including new module surfaces", async () => withProject(async (root) => {
    const result = await rules(root, join(root, "src/app/public/new.ts"));
    expect(result).toMatchObject({ exists: false, module: "app", isSurfaceFile: true });
    expect((await rules(root, join(root, "src/app/new.ts"))).isSurfaceFile).toBe(false);
    expect(await rules(root, join(root, "src/app/new.d.ts"))).toMatchObject({ exists: false, module: "app" });
    expect(await rules(root, join(root, "src/future/index.ts"))).toMatchObject({ exists: false, module: "future", isSurfaceFile: true });
  }));

  test("lists existing public surfaces and matching friend entries", async () => withProject(async (root) => {
    const result = await rules(root, join(root, "src/app/new.ts"));
    expect(result.importableFrom).toEqual([{ module: "shared", surfaceFiles: [join(root, "src/shared/index.ts")] }]);
    expect(result.friendAccess).toEqual([{ module: "shared", file: "src/shared/secret.ts", from: "src/app/**", because: "app may use the helper" }]);
    const other = await rules(root, join(root, "src/other/new.ts"));
    expect(other.friendAccess).toEqual([]);
    expect(other.importableFrom.map((entry) => entry.module)).toEqual(["app", "shared"]);
  }));

  test("excluded paths retain descriptive results but suppress violations", async () => withProject(async (root) => {
    const result = await rules(root, join(root, "src/app/ignored/new.ts"));
    expect(result).toMatchObject({ exists: false, excluded: true, module: "app", uncoveredViolation: undefined, mustBeEmptyViolation: undefined });
    expect(formatRulesText(result).startsWith("excluded - out of scope, none of the following apply\n")).toBe(true);
    const existing = await rules(root, join(root, "src/app/ignored/old.ts"));
    expect(existing.module).toBeUndefined();
    expect(existing.uncoveredViolation).toBeUndefined();
    writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({ ...config, exclude: [...config.exclude, "src/empty/**"] })};`);
    expect((await rules(root, join(root, "src/empty/new.ts"))).mustBeEmptyViolation).toBeUndefined();
  }));

  test("reuses uncovered and must-be-empty violations for present and planned files", async () => withProject(async (root) => {
    for (const name of ["old.ts", "new.ts"]) {
      const path = join(root, "src/empty", name);
      const result = await rules(root, path);
      expect(result.uncoveredViolation).toEqual(uncoveredViolationFor(path, root));
      expect(result.mustBeEmptyViolation).toEqual(checkMustBeEmpty([`src/empty/${name}`], config)[0]);
      for (const violation of [result.uncoveredViolation!, result.mustBeEmptyViolation!]) {
        const text = formatRulesText(result);
        expect(text).toContain(`evidence: ${violation.evidence}`);
        expect(text).toContain(`because: ${violation.because}`);
        expect(text).toContain(`next: ${violation.next}`);
      }
    }
    const actual = await check(root);
    const planned = await rules(root, join(root, "src/empty/old.ts"));
    expect(actual.violations).toContainEqual(planned.uncoveredViolation);
    expect(actual.violations).toContainEqual(planned.mustBeEmptyViolation);
  }));

  test("rejects paths outside the project, including symlink escapes", async () => withProject(async (root) => {
    await expect(rules(root, join(root, "../outside.ts"))).rejects.toThrow(/outside project root/);
    symlinkSync(dirname(root), join(root, "escape"));
    await expect(rules(root, join(root, "escape/new.ts"))).rejects.toThrow(/outside project root/);
  }));

  test("CLI JSON returns the verb result for a relative missing path", async () => withProject(async (root) => {
    const result = runCli(root, ["src/app/new.ts", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(await rules(root, join(root, "src/app/new.ts")))));
  }));

  test("CLI text prints the path plan and friend access", async () => withProject(async (root) => {
    const result = runCli(root, ["src/app/new.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe([
      `path: ${root}/src/app/new.ts`, "exists: false", "excluded: no", "module: app",
      "tags: a:code, area:app, z:source", "surface file: no", "must-be-empty: ok",
      "importable from:", `  shared -> ${root}/src/shared/index.ts`, "friend access:",
      "  shared -> src/shared/secret.ts", "    from: src/app/**", "    because: app may use the helper", "",
    ].join("\n"));
  }));

  test("CLI reports missing arguments and config errors through the common catch", async () => withProject(async (root) => {
    for (const args of [["--json"], ["../outside.ts", "--json"]]) {
      const result = runCli(root, args);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).toBeTypeOf("string");
    }
    writeFileSync(join(root, "archstrict.config.ts"), "export default {};\n");
    const result = runCli(root, ["src/app/new.ts", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("missing required field");
  }));
});

test("uncovered extraction preserves the original serialized report", () => {
  const file = "/project/loose.ts";
  const graph = { rootDir: "/project", outsideFiles: [file] } as ModuleGraph;
  const expected = [{ rule: "uncovered-module", path: file, line: 1, column: 1,
    evidence: "'/project/loose.ts' is in scope but matches no declared module",
    because: "a file matching no declared module is unchecked, not passing (deptrac's --fail-on-uncovered)",
    next: "add a declaredModules entry covering 'loose.ts' in archstrict.config.ts, or add it to exclude if it isn't module content" }];
  expect(JSON.stringify(checkUncoveredModules(graph))).toBe(JSON.stringify(expected));
});
