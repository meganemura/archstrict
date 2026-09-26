// Responsibility: verify cache equivalence and invalidation against real TypeScript graphs.
// Boundary: compiler spies observe calls; all resolution still uses the real compiler.
import { beforeEach, expect, test, vi } from "vitest";
import ts from "typescript";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync, utimesSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildModuleGraph, buildModuleGraphForRules, type ModuleGraph, type BuildOptions } from "../src/module-graph.js";
import { rules } from "../src/verbs/rules.js";

const calls = vi.hoisted(() => ({ checker: vi.fn() }));
vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof ts }>();
  return { ...actual, default: { ...actual.default, createProgram: vi.fn((options: ts.CreateProgramOptions) => {
    const program = actual.default.createProgram(options);
    const getChecker = program.getTypeChecker;
    program.getTypeChecker = () => { calls.checker(); return getChecker(); };
    return program;
  }),
  // The edge path (below) parses each file through this, never through a
  // whole-project ts.Program. Spied so a test can tell a real cache hit
  // (no per-file walk, so no call at all) from a rebuild (one call per
  // root file) - the same distinction the ts.createProgram spy above
  // gives for `program`/`checker` access specifically.
  createSourceFile: vi.fn((...args: Parameters<typeof ts.createSourceFile>) => actual.default.createSourceFile(...args)) } };
});
beforeEach(() => vi.clearAllMocks());

async function project(fn: (root: string, options: BuildOptions) => void | Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-edge-cache-")));
  const declaredModules = [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }];
  for (const name of ["a", "b"]) mkdirSync(join(root, "src", name), { recursive: true });
  writeFileSync(join(root, "src/a/index.ts"), 'import { b } from "../b/index.js"; export const a = b;\n');
  writeFileSync(join(root, "src/b/index.ts"), 'export const b = 1;\n');
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext"}}');
  writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({ declaredModules, because: "test architecture", classify: [], exclude: ["*.ts"] })};`);
  try { await fn(root, { projectRoot: root, declaredModules, exclude: ["*.ts"] }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function cachePath(root: string) { return join(root, "node_modules/.cache/archstrict/edges.json"); }
function bump(path: string) {
  const stat = statSync(path);
  utimesSync(path, stat.atime, new Date(stat.mtimeMs + 2000));
}
function facts(graph: ModuleGraph) {
  return { modules: [...graph.modules], edges: graph.edges, crossModuleEdges: graph.crossModuleEdges,
    outsideFiles: graph.outsideFiles, unsupportedSyntaxCount: graph.unsupportedSyntaxCount,
    unresolvedSpecifierCount: graph.unresolvedSpecifierCount, unresolvedSpecifiers: graph.unresolvedSpecifiers,
    surface: graph.surface, rootDir: graph.rootDir };
}

test("checker is lazy, including on a cache hit", async () => project((_root, options) => {
  const graph = buildModuleGraph(options);
  expect(calls.checker).not.toHaveBeenCalled();
  expect(graph.checker).toBe(graph.program.getTypeChecker());
  expect(calls.checker).toHaveBeenCalled();
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  const warm = buildModuleGraphForRules(options);
  expect(ts.createProgram).not.toHaveBeenCalled();
  expect(calls.checker).not.toHaveBeenCalled();
  expect(warm.checker).toBe(warm.program.getTypeChecker());
  expect(ts.createProgram).toHaveBeenCalledTimes(1);
}));

test("rules writes keys and reuses edges without a per-file walk on a cache hit", async () => project(async (root) => {
  const path = join(root, "src/a/index.ts");
  const first = await rules(root, path);
  expect(ts.createSourceFile).toHaveBeenCalled(); // a cache miss walks every root file
  expect(ts.createProgram).not.toHaveBeenCalled();
  expect(calls.checker).not.toHaveBeenCalled();
  const cache = JSON.parse(readFileSync(cachePath(root), "utf8"));
  expect(cache.files[path].mtimeMs).toBe(statSync(path).mtimeMs);
  expect(cache.files[path].edges[0].specifier).toBe("../b/index.js");
  expect(cache.tsconfigHash).toMatch(/^[a-f0-9]{64}$/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(cache.archstrictVersion).toBe(pkg.version);
  vi.clearAllMocks();
  expect(await rules(root, path)).toEqual(first);
  expect(ts.createSourceFile).not.toHaveBeenCalled(); // a cache hit re-parses nothing
  expect(ts.createProgram).not.toHaveBeenCalled();
}));

test.each(["edit", "add", "delete"])("source %s rebuilds the whole cache", async (operation) => project(async (root) => {
  const path = join(root, "src/a/index.ts");
  await rules(root, path);
  const before = readFileSync(cachePath(root), "utf8");
  vi.clearAllMocks();
  if (operation === "edit") { writeFileSync(path, 'import "node:fs";'); bump(path); }
  if (operation === "add") writeFileSync(join(root, "src/b/new.ts"), 'export const n = 1;');
  if (operation === "delete") rmSync(join(root, "src/b/index.ts"));
  await rules(root, path);
  expect(ts.createSourceFile).toHaveBeenCalled();
  expect(readFileSync(cachePath(root), "utf8")).not.toBe(before);
  vi.clearAllMocks();
  await rules(root, path);
  expect(ts.createSourceFile).not.toHaveBeenCalled();
}));

test.each(["package.json", "src/a/package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"])("%s metadata changes invalidate the cache", async (file) => project((root, options) => {
  const path = join(root, file);
  writeFileSync(path, "{}");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).not.toHaveBeenCalled();
  bump(path);
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  vi.clearAllMocks();
  rmSync(path);
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  vi.clearAllMocks();
  writeFileSync(path, "{}");
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
}));

test.each(["tsconfig.json", "src/a/tsconfig.json"])("effective options in %s invalidate cached resolutions", async (file) => project((root, options) => {
  buildModuleGraphForRules(options);
  const before = JSON.parse(readFileSync(cachePath(root), "utf8")).tsconfigHash;
  vi.clearAllMocks();
  writeFileSync(join(root, file), JSON.stringify({ compilerOptions: { noLib: true, types: [], paths: { alias: ["./src/b/index.ts"] } } }));
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  expect(JSON.parse(readFileSync(cachePath(root), "utf8")).tsconfigHash).not.toBe(before);
}));

test("version mismatches, malformed caches and declaration changes rebuild", async () => project((root, options) => {
  buildModuleGraphForRules(options);
  const path = cachePath(root);
  const cache = JSON.parse(readFileSync(path, "utf8"));
  cache.archstrictVersion = "different";
  writeFileSync(path, JSON.stringify(cache));
  vi.clearAllMocks();
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  writeFileSync(path, '{"files":');
  vi.clearAllMocks();
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  const changed = { ...options, declaredModules: [{ name: "all", glob: "src/**" }] };
  expect(facts(buildModuleGraphForRules(changed))).toEqual(facts(buildModuleGraph(changed)));
}));

test("package exports changes refresh both target edges and derived surfaces", async () => project((root, options) => {
  const pkg = join(root, "src/b/package.json");
  writeFileSync(join(root, "src/b/other.ts"), 'export const b = 2;');
  writeFileSync(pkg, JSON.stringify({ name: "@test/b", type: "module", exports: "./index.ts" }));
  writeFileSync(join(root, "src/b/index.ts"), 'import "@test/b"; export const b = 1;');
  const first = buildModuleGraphForRules(options);
  expect(first.edges.find((e) => e.specifier === "@test/b")?.resolvedFile).toBe(join(root, "src/b/index.ts"));
  expect(first.modules.get("b")?.surfaceFiles).toEqual([join(root, "src/b/index.ts")]);
  writeFileSync(pkg, JSON.stringify({ name: "@test/b", type: "module", exports: "./other.ts" }));
  bump(pkg);
  vi.clearAllMocks();
  const next = buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  expect(next.edges.find((e) => e.specifier === "@test/b")?.resolvedFile).toBe(join(root, "src/b/other.ts"));
  expect(next.modules.get("b")?.surfaceFiles).toEqual([join(root, "src/b/other.ts")]);
  vi.clearAllMocks();
  expect(facts(buildModuleGraphForRules(options))).toEqual(facts(next));
  expect(ts.createSourceFile).not.toHaveBeenCalled();
}));

test("a cache path that cannot be written still returns a fresh graph", async () => project((root, options) => {
  writeFileSync(join(root, "node_modules"), "not a directory");
  const graph = buildModuleGraphForRules(options);
  expect(graph.edges.some((edge) => edge.toModule === "b")).toBe(true);
  // The cache write itself failed (no writable node_modules/), so every
  // call re-walks - there is nothing on disk to hit.
  vi.clearAllMocks();
  expect(facts(buildModuleGraphForRules(options))).toEqual(facts(graph));
  expect(ts.createSourceFile).toHaveBeenCalled();
}));

// root bypasses every permission bit, so chmod 000 would still read; this
// suite's own CI never runs as root, but a local run might.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable root file is invisible on both a cold build and a cache hit",
  async () => project(async (root, options) => {
    const unreadable = join(root, "src/a/secret.ts");
    writeFileSync(unreadable, "export const secret = 1;\n");
    chmodSync(unreadable, 0o000);
    try {
      const cold = buildModuleGraphForRules(options);
      // Invisible exactly like buildPreparedGraph's own per-file walk
      // treats an unreadable file (module-graph.ts's own header) - joining
      // neither its module's own `files` nor `outsideFiles`.
      expect(cold.modules.get("a")?.files).not.toContain(unreadable);
      expect(cold.outsideFiles).not.toContain(unreadable);
      vi.clearAllMocks();
      const warm = buildModuleGraphForRules(options);
      expect(ts.createSourceFile).not.toHaveBeenCalled(); // a real cache hit, not a second cold build
      expect(facts(warm)).toEqual(facts(cold));
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }),
);

test("cold and warm graphs preserve generated imports and diagnostics", async () => {
  await hegel.testAsync(async (tc) => project((_root, options) => {
    const imports = tc.draw(gen.arrays(gen.sampledFrom([
      'import "node:fs";', 'export { b } from "../b/index.js";',
      'import type { B } from "../b/index.js";', 'void import("../b/index.js");',
      'import "missing-package";', 'require("../b/index.js");',
    ])));
    writeFileSync(join(options.projectRoot, "src/a/index.ts"), imports.join("\n"));
    const expected = facts(buildModuleGraph(options));
    const cold = facts(buildModuleGraphForRules(options));
    vi.clearAllMocks();
    expect(facts(buildModuleGraphForRules(options))).toEqual(expected);
    expect(cold).toEqual(expected);
    expect(ts.createSourceFile).not.toHaveBeenCalled(); // now cached: no per-file walk on the second call
    expect(ts.createProgram).not.toHaveBeenCalled();
  }));
});
