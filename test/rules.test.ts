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
import { suggestUncovered, groupForRelFile } from "../src/module-candidates.js";
import { checkMustBeEmpty } from "../src/rules/must-be-empty.js";
import { check, loadConfig } from "../src/verbs/check.js";
import { checkEdgesCoverage, checkOrder, checkPoint, formatPredicate } from "../src/rules/constraints.js";
import { buildModuleGraph } from "../src/module-graph.js";
import type { Config } from "../src/config.js";
import type { ModuleGraph } from "../src/module-graph.js";
import { makeProjectRelativePosix } from "../src/project-path.js";

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
      // "src/empty" is a directory group under this config (its own
      // src/app, src/shared, src/private, src/future entries all anchor
      // at "src") - old.ts and new.ts share the one "empty" suggestion.
      const groups = suggestUncovered(["src/empty/old.ts", "src/empty/new.ts"], config.declaredModules);
      const group = groupForRelFile(`src/empty/${name}`, groups)!;
      expect(result.uncoveredViolation).toEqual(uncoveredViolationFor(path, root, group));
      expect(result.mustBeEmptyViolation).toEqual(checkMustBeEmpty([`src/empty/${name}`], config)[0]);
      for (const violation of [result.uncoveredViolation!, result.mustBeEmptyViolation!]) {
        const text = formatRulesText(result);
        expect(text).toContain(`evidence: ${violation.evidence}`);
        expect(text).toContain(`because: ${violation.because}`);
        expect(text).toContain(`do: ${violation.do}`);
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
      "  shared -> src/shared/secret.ts", "    from: src/app/**", "    because: app may use the helper",
      "allowDeny constraints: (none)", "order constraints: (none)", "point constraints: (none)", "",
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

  test("a config's top-level surface makes rules agree with check about which file is the public surface", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-rules-surface-")));
    try {
      for (const file of ["src/a/clean.ts", "src/a/bad.ts", "src/b/main.ts", "src/b/index.ts"]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
      }
      writeFileSync(join(root, "src/b/main.ts"), "export const value = 1;\n");
      writeFileSync(join(root, "src/b/index.ts"), "export const value = 2;\n");
      writeFileSync(join(root, "src/a/clean.ts"), "import { value } from \"../b/main.ts\";\nexport const x = value;\n");
      writeFileSync(join(root, "src/a/bad.ts"), "import { value } from \"../b/index.ts\";\nexport const y = value;\n");
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
        exclude: ["archstrict.config.ts"],
        surface: "main.ts",
        because: "test",
      })};`);

      const main = await rules(root, join(root, "src/b/main.ts"));
      expect(main).toMatchObject({ exists: true, module: "b", isSurfaceFile: true });
      const indexResult = await rules(root, join(root, "src/b/index.ts"));
      expect(indexResult).toMatchObject({ exists: true, module: "b", isSurfaceFile: false });

      const checked = await check(root);
      expect(checked.violations).toHaveLength(1);
      expect(checked.violations[0]).toMatchObject({ rule: "public-surface-bypass", path: join(root, "src/a/bad.ts") });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("uncovered extraction preserves the original serialized report", () => {
  const file = "/project/loose.ts";
  const graph = { rootDir: "/project", outsideFiles: [file], relativePath: makeProjectRelativePosix("/project") } as ModuleGraph;
  const expected = [{ rule: "uncovered-module", path: file, line: 1, column: 1,
    evidence: "'/project/loose.ts' is in scope but matches no declared module",
    because: "a file matching no declared module is unchecked, not passing",
    do: 'add { name: "loose.ts", glob: "loose.ts", surface: "loose.ts" } to declaredModules in archstrict.config.ts, or add "loose.ts" to exclude if it is not module content; then run archstrict init' }];
  expect(JSON.stringify(checkUncoveredModules(graph, {}))).toBe(JSON.stringify(expected));
});

describe("constraint projections", () => {
  test("allowDeny selects source tags, copies lists, and filters exception importers", async () => withProject(async (root) => {
    const edges: Config["edges"] = { allowDeny: [
      { source: "a:code", targetNamespace: "kind", allow: ["shared"], deny: ["private"], because: "allowed targets", exceptions: [
        { from: "src/app/**", to: "src/private/**", because: "special access" },
        { from: "other/**", to: "src/shared/**", because: "unrelated" },
      ], edgeType: "value", importForm: "static" },
      { source: "z:source", targetNamespace: "kind", deny: ["private"], because: "deny targets" },
      { source: "missing:tag", targetNamespace: "kind", allow: [], because: "unrelated rule" },
    ] };
    const path = join(root, "archstrict.config.ts");
    writeFileSync(path, `export default ${JSON.stringify({ ...config, edges })};`);
    const loaded = await loadConfig(path);
    const result = await rules(root, join(root, "src/app/new.ts"));
    expect(result.allowDenyConstraints).toEqual([
      { source: "a:code", targetNamespace: "kind", allow: ["shared"], deny: ["private"], sameGroupExempt: true,
        exceptionsFromP: [{ to: "src/private/**", because: "special access" }], edgeType: "value", importForm: "static", because: "allowed targets" },
      { source: "z:source", targetNamespace: "kind", allow: undefined, deny: ["private"], sameGroupExempt: true,
        exceptionsFromP: [], edgeType: "both", importForm: "both", because: "deny targets" },
    ]);
    expect(result.allowDenyConstraints[0]!.allow).not.toBe(loaded.edges!.allowDeny![0]!.allow);
    expect(result.allowDenyConstraints[0]!.deny).not.toBe(loaded.edges!.allowDeny![0]!.deny);
    expect(formatRulesText(result)).toContain('  same group exempt: true\n');
    expect(formatRulesText(result)).toContain('  exceptions from path: [{"to":"src/private/**","because":"special access"}]');
    const cliResult = runCli(root, ["src/app/new.ts", "--json"]);
    expect(cliResult.status).toBe(0);
    expect(JSON.parse(cliResult.stdout).allowDenyConstraints).toEqual(JSON.parse(JSON.stringify(result.allowDenyConstraints)));
  }));

  test("order skips missing namespaces and scopes, and includes the source layer in the prefix", async () => withProject(async (root) => {
    const edges: Config["edges"] = { order: [
      { tagNamespace: "layer", within: "area", sequence: { app: ["core", "service", "ui"] }, direction: "downward-only", because: "layer order", edgeType: "type", importForm: "dynamic" },
      { tagNamespace: "unknown", sequence: { "": ["core"] }, direction: "downward-only", because: "missing layer namespace" },
      { tagNamespace: "layer", within: "missing", sequence: { "": ["core"] }, direction: "downward-only", because: "missing within namespace" },
      { tagNamespace: "layer", within: "area", sequence: { shared: ["core"] }, direction: "downward-only", because: "undeclared within value" },
      { tagNamespace: "layer", sequence: { "": ["core", "service"] }, direction: "downward-only", because: "unscoped" },
    ] };
    const path = join(root, "archstrict.config.ts");
    writeFileSync(path, `export default ${JSON.stringify({ ...config, classify: [{ glob: "src/**", tags: ["layer:service"] }], edges })};`);
    const loaded = await loadConfig(path);
    const result = await rules(root, join(root, "src/app/new.ts"));
    expect(result.orderConstraints).toEqual([
      { tagNamespace: "layer", within: "area", ownLayer: "service", sequence: ["core", "service", "ui"], mayDependOn: ["core", "service"], edgeType: "type", importForm: "dynamic", because: "layer order" },
      { tagNamespace: "layer", within: undefined, ownLayer: "service", sequence: ["core", "service"], mayDependOn: ["core", "service"], edgeType: "both", importForm: "both", because: "unscoped" },
    ]);
    expect(result.orderConstraints[0]!.sequence).not.toBe(loaded.edges!.order![0]!.sequence.app);
    expect(formatRulesText(result)).toContain('  may depend on: ["core","service"]');
  }));

  test("order detects an unlisted source layer before an edge exists with check's exact error", async () => withProject(async (root) => {
    const cfg: Config = { ...config, configPath: join(root, "archstrict.config.ts"), classify: [{ glob: "src/**", tags: ["layer:missing"] }],
      edges: { order: [{ tagNamespace: "layer", sequence: { "": ["core"] }, direction: "downward-only", because: "all layers must be placed" }] } };
    writeFileSync(cfg.configPath, `export default ${JSON.stringify(cfg)};`);
    const message = "order rule for 'layer' (within '(unscoped)') does not list 'missing' - every value classify assigns within that scope must appear in its sequence";
    await expect(rules(root, join(root, "src/app/new.ts"))).rejects.toThrow(message);
    writeFileSync(join(root, "src/app/main.ts"), 'import { value } from "./public/api.js"; export { value };');
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules!, exclude: cfg.exclude });
    expect(() => checkOrder(graph, cfg)).toThrow(message);
  }));

  test("point uses glob and tag predicates and preserves check identifiers", async () => withProject(async (root) => {
    const cfg: Config = { ...config, configPath: join(root, "archstrict.config.ts"), edges: { point: [
      { from: "src/app/**", to: "src/shared/**", because: "glob rule" },
      { from: { tags: ["area:app"], exclude: { tags: ["role:adapter"] } }, to: { tags: ["area:shared"] }, edgeType: "value", importForm: "static", because: "tag rule" },
      { from: "other/**", to: "src/**", because: "wrong glob" },
      { from: { tags: ["area:shared"] }, to: "src/**", because: "wrong tag" },
      { from: { tags: ["area:app"], exclude: { tags: ["a:code"] } }, to: "src/**", because: "excluded tag" },
    ] } };
    writeFileSync(cfg.configPath, `export default ${JSON.stringify(cfg)};`);
    writeFileSync(join(root, "src/app/main.ts"), 'import { value } from "../shared/index.js"; export { value };');
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules!, exclude: cfg.exclude });
    const result = await rules(root, join(root, "src/app/main.ts"));
    expect(result.pointConstraints).toHaveLength(2);
    const violations = checkPoint(graph, cfg);
    expect(violations).toHaveLength(2);
    const coverage = checkEdgesCoverage(graph, cfg).filter((c) => c.kind === "point");
    for (const [i, projection] of result.pointConstraints.entries()) {
      const rule = cfg.edges!.point![i]!;
      expect(projection.identifier).toBe(`${formatPredicate(rule.from)} -> ${formatPredicate(rule.to)}`);
      expect(projection.identifier).toBe(coverage[i]!.identifier);
      expect(violations[i]!.do).toContain(`'${projection.identifier}'`);
      expect(projection.forbiddenTo).toBe(formatPredicate(rule.to));
    }
    expect(result.pointConstraints[0]).toMatchObject({ edgeType: "both", importForm: "both" });
    expect(result.pointConstraints[1]).toMatchObject({ edgeType: "value", importForm: "static" });
    expect(formatRulesText(result)).toContain('  forbidden to: {"tags":["area:shared"]}');
  }));
});

test.each([
  ["z", "a"],
  ["a", "z"],
])("order projection and check select the same layer and scope from %s then %s", async (first, second) => withProject(async (root) => {
  const cfg: Config = {
    ...config,
    configPath: join(root, "archstrict.config.ts"),
    classify: [
      { glob: "src/app/**", tags: [`layer:${first}`, `layer:${second}`, `scope:${first}`, `scope:${second}`] },
      { glob: "src/shared/**", tags: ["layer:target", `scope:${first}`, `scope:${second}`] },
    ],
    edges: { order: [{ tagNamespace: "layer", within: "scope", sequence: {
      [first]: [first, "target", second],
      [second]: [second, "target", first],
    }, direction: "downward-only", because: "consistent selection" }] },
  };
  writeFileSync(cfg.configPath, `export default ${JSON.stringify(cfg)};`);
  writeFileSync(join(root, "src/app/main.ts"), 'import { value } from "../shared/index.js"; export { value };');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules!, exclude: cfg.exclude });
  const violations = checkOrder(graph, cfg);
  expect(violations).toHaveLength(1);
  expect(violations[0]!.evidence).toBe(`'../shared/index.js' reaches 'layer:target' from 'layer:${first}' (layer sequence: ${first} -> target -> ${second})`);
  const result = await rules(root, join(root, "src/app/main.ts"));
  expect(result.tags).toEqual(["area:app", "layer:a", "layer:z", "scope:a", "scope:z"]);
  expect(result.orderConstraints).toHaveLength(1);
  expect(result.orderConstraints[0]).toMatchObject({ ownLayer: first, sequence: [first, "target", second], mayDependOn: [first] });
}));
