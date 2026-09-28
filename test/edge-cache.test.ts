// Responsibility: verify the persistent, per-file cache's equivalence with
// a cold build and its own invalidation rules, against real TypeScript
// graphs.
// Boundary: compiler spies observe calls; all resolution still uses the
// real compiler.
import { beforeEach, expect, test, vi } from "vitest";
import ts from "typescript";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, realpathSync, statSync, utimesSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildModuleGraph, buildModuleGraphForRules, buildPreparedGraph, prepareGraph, type ModuleGraph, type BuildOptions } from "../src/module-graph.js";
import { readEdgeCache, writeEdgeCache, shardIndexForRelativePath, SHARD_COUNT, type EdgeCache, type CachedFileEntry, type CachedResolution } from "../src/edge-cache.js";
import { rules } from "../src/verbs/rules.js";
import { check, filterToFile } from "../src/verbs/check.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

// `failRenameTo`: set to an absolute path to make exactly the next
// `renameSync` call whose own destination is that path throw, then reset
// itself - used to simulate a process crashing between a shard's own
// atomic rename and the header's (writeEdgeCache writes shards first,
// the header last; a crash in between leaves every shard's own rename
// already committed, with the header's own rename never reached).
const calls = vi.hoisted(() => ({ checker: vi.fn(), realpath: vi.fn(), failRenameTo: undefined as string | undefined }));
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
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: Object.assign(
    (...args: Parameters<typeof import("node:fs").realpathSync>) => { calls.realpath(); return actual.realpathSync(...args); },
    actual.realpathSync,
  ), renameSync: Object.assign(
    (...args: Parameters<typeof import("node:fs").renameSync>) => {
      if (calls.failRenameTo !== undefined && String(args[1]) === calls.failRenameTo) {
        calls.failRenameTo = undefined;
        throw new Error("simulated crash before this rename");
      }
      return actual.renameSync(...args);
    },
    actual.renameSync,
  ) };
});
beforeEach(() => { vi.clearAllMocks(); calls.failRenameTo = undefined; });

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
// Routes a direct, file-level read through the real decoder - this
// module's own on-disk shape (a header plus sharded, index-encoded
// files) is never something a test should re-implement.
function readCache(root: string): EdgeCache { return readEdgeCache(cachePath(root), root)!; }
function shardFilePath(root: string, relativePath: string): string {
  return join(root, "node_modules/.cache/archstrict/edges", `${shardIndexForRelativePath(relativePath)}.json`);
}
function mtimesOf(paths: readonly string[]): number[] {
  return paths.map((p) => { try { return statSync(p).mtimeMs; } catch { return -1; } });
}
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
function parsedFiles(): string[] {
  return vi.mocked(ts.createSourceFile).mock.calls.map((args) => args[0] as string);
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

test("rules writes a per-file cache entry and reuses it without a per-file walk on a cache hit", async () => project(async (root) => {
  const path = join(root, "src/a/index.ts");
  const first = await rules(root, path);
  expect(ts.createSourceFile).toHaveBeenCalled(); // a cache miss walks every root file
  expect(ts.createProgram).not.toHaveBeenCalled();
  expect(calls.checker).not.toHaveBeenCalled();
  const cache = readCache(root);
  expect(cache.schema).toBe(10);
  expect(cache.files[path]!.mtimeMs).toBe(statSync(path).mtimeMs);
  expect(cache.files[path]!.imports[0]!.specifier).toBe("../b/index.js");
  const resolution = cache.files[path]!.resolutions["../b/index.js\u000099"];
  expect(resolution === "unresolved" ? undefined : resolution?.resolvedFile).toBe(join(root, "src/b/index.ts"));
  expect(cache.optionsTable).toHaveLength(1);
  expect(cache.resolutionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(cache.archstrictVersion).toBe(pkg.version);
  vi.clearAllMocks();
  expect(await rules(root, path)).toEqual(first);
  expect(ts.createSourceFile).not.toHaveBeenCalled(); // a real cache hit re-parses nothing
  expect(ts.createProgram).not.toHaveBeenCalled();
}));

test("module-augmentation specifiers survive a cache hit without a reparse", async () => project(async (root, options) => {
  const augmentation = join(root, "src/b/augment.ts");
  writeFileSync(augmentation, 'export {}; declare module "../a/index.js" { interface A { extra: string } }\n');
  buildModuleGraphForRules(options);
  expect(readCache(root).files[augmentation]!.hasModuleAugmentation).toBe(true);
  expect(readCache(root).files[augmentation]!.moduleAugmentationSpecifiers.map((item) => item.specifier))
    .toEqual(["../a/index.js"]);
  vi.clearAllMocks();
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).not.toHaveBeenCalled();
  expect(readCache(root).files[augmentation]!.hasModuleAugmentation).toBe(true);
}));

// One file's own edit reparses exactly that file - never the rest of the
// project.
test("one file edited re-parses exactly one file", async () => project(async (root, options) => {
  const a = join(root, "src/a/index.ts");
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  writeFileSync(a, 'import { b } from "../b/index.js"; export const a2 = b;\n');
  bump(a);
  const graph = buildModuleGraphForRules(options);
  expect(parsedFiles()).toEqual([a]);
  expect(graph.edges.some((e) => e.resolvedFile === b)).toBe(true);
}));

// Adding a file parses only the new file; deleting one parses nothing - a
// deletion never needs a parse, only a re-resolution of whoever imported
// it.
test("adding a file parses only that file", async () => project(async (root, options) => {
  const c = join(root, "src/b/new.ts");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  writeFileSync(c, "export const n = 1;\n");
  const graph = buildModuleGraphForRules(options);
  expect(parsedFiles()).toEqual([c]);
  expect(graph.modules.get("b")?.files).toContain(c);
}));

test("deleting a file re-parses nothing but drops its cache entry and its importer's now-unresolved edge", async () => project(async (root, options) => {
  const a = join(root, "src/a/index.ts");
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  rmSync(b);
  const graph = buildModuleGraphForRules(options);
  expect(parsedFiles()).toEqual([]);
  expect(graph.unresolvedSpecifiers).toContain("../b/index.js");
  const cache = readCache(root);
  expect(Object.hasOwn(cache.files, b)).toBe(false);
}));

// Renaming is a delete plus an add from this cache's own point of view -
// the new path gets its own fresh parse, the old path's entry is gone,
// and neither forces a reparse of the untouched importer beyond its own
// re-resolution.
test("renaming a file parses only its new path", async () => project(async (root, options) => {
  const a = join(root, "src/a/index.ts");
  const b = join(root, "src/b/index.ts");
  const renamed = join(root, "src/b/moved.ts");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  renameSync(b, renamed);
  writeFileSync(a, 'import { b } from "../b/moved.js"; export const a = b;\n');
  bump(a);
  const graph = buildModuleGraphForRules(options);
  expect(parsedFiles().sort()).toEqual([a, renamed].sort());
  expect(graph.edges.some((e) => e.resolvedFile === renamed)).toBe(true);
}));

// Touching a file (an mtime bump alone, no byte change) is treated as a
// possible change, the same as a real edit - module-graph.ts's own
// reparse gate is mtime+size, not a content hash, matching the same
// signal warm-graph.ts's own per-process cache already keys on. This
// costs one needless reparse of the touched file, never the rest of the
// project, and the result still agrees with a cold build either way.
test("touching a file gives the same graph as a cold build", async () => project(async (root, options) => {
  const a = join(root, "src/a/index.ts");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  bump(a);
  const warm = facts(buildModuleGraphForRules(options));
  expect(warm).toEqual(facts(buildModuleGraph(options)));
}));

// This fixture's own two files land in different shards (checked below,
// not assumed) - src/a/index.ts's own edit must rewrite only its own
// shard, never src/b/index.ts's.
test("touching a file rewrites exactly its own shard file, plus the header", async () => project(async (root, options) => {
  const shardA = shardFilePath(root, "src/a/index.ts");
  const shardB = shardFilePath(root, "src/b/index.ts");
  expect(shardA).not.toBe(shardB);
  buildModuleGraphForRules(options);
  const header = cachePath(root);
  const old = new Date(Date.now() - 60_000);
  for (const p of [shardA, shardB, header]) utimesSync(p, old, old);
  const before = mtimesOf([shardA, shardB, header]);
  bump(join(root, "src/a/index.ts"));
  buildModuleGraphForRules(options);
  const after = mtimesOf([shardA, shardB, header]);
  expect(after[0]).not.toBe(before[0]); // shard A rewritten
  expect(after[1]).toBe(before[1]); // shard B untouched
  expect(after[2]).not.toBe(before[2]); // header rewritten last, every time
}));

test("a corrupt shard file re-walks only its own files, and still agrees with a cold build", async () => project(async (root, options) => {
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options);
  writeFileSync(shardFilePath(root, "src/b/index.ts"), "{not json");
  vi.clearAllMocks();
  const warm = facts(buildModuleGraphForRules(options));
  expect(parsedFiles()).toEqual([b]); // src/a/index.ts's own valid shard is never re-walked
  expect(warm).toEqual(facts(buildModuleGraph(options)));
  vi.clearAllMocks();
  expect(facts(buildModuleGraphForRules(options))).toEqual(warm);
  expect(ts.createSourceFile).not.toHaveBeenCalled(); // the rewrite this build made is itself valid
}));

test("a missing shard file behaves the same way as a corrupt one", async () => project(async (root, options) => {
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options);
  rmSync(shardFilePath(root, "src/b/index.ts"));
  vi.clearAllMocks();
  const warm = facts(buildModuleGraphForRules(options));
  expect(parsedFiles()).toEqual([b]);
  expect(warm).toEqual(facts(buildModuleGraph(options)));
}));

// The shard file itself stays perfectly parseable here - only the
// header's own recorded hash for it is wrong - so this exercises the
// hash check specifically, not the JSON.parse failure the two tests
// above already cover.
test("a header naming a shard whose hash no longer matches behaves the same way", async () => project(async (root, options) => {
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options);
  const header = JSON.parse(readFileSync(cachePath(root), "utf8"));
  const idx = shardIndexForRelativePath("src/b/index.ts");
  header.shards[idx].hash = "d".repeat(64);
  writeFileSync(cachePath(root), JSON.stringify(header));
  vi.clearAllMocks();
  const warm = facts(buildModuleGraphForRules(options));
  expect(parsedFiles()).toEqual([b]);
  expect(warm).toEqual(facts(buildModuleGraph(options)));
}));

// writeEdgeCache writes every dirty shard first (each its own atomic
// rename), the header last - so a process that crashes in between leaves
// every shard's own rename already committed, with the header's own
// rename never reached. The header on disk is then the OLD one: still
// naming this shard by its OLD hash, which no longer matches the NEW
// shard bytes the crashed build did manage to commit.
test("a header never rewritten because the process crashed before its own rename still only re-walks the one shard that changed", async () => project(async (root, options) => {
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options); // build 1: a normal, fully-written cache
  writeFileSync(b, 'import { a } from "../a/index.js"; export const b2 = a;\n');
  bump(b);
  calls.failRenameTo = cachePath(root); // fails only the header's own rename, once
  buildModuleGraphForRules(options); // build 2: shard b rewritten for real; the header's own rename throws and is swallowed
  expect(calls.failRenameTo).toBeUndefined(); // the throw fired - this build really did crash before its header write
  vi.clearAllMocks();
  const warm = facts(buildModuleGraphForRules(options)); // build 3: reads the stale (pre-crash) header
  expect(parsedFiles()).toEqual([b]); // only shard b's own files miss and re-walk
  expect(warm).toEqual(facts(buildModuleGraph(options)));
}));

// A second, concurrent cache writer can read the header before this
// build's own write lands, then write its own header back with this
// shard's OLD hash - a lost update, not a crash. The shard file on disk
// still holds the bytes THIS build wrote; the header now names it by a
// hash valid only for the version before it.
test("a header naming a shard by another writer's stale hash still only re-walks that one shard", async () => project(async (root, options) => {
  const b = join(root, "src/b/index.ts");
  buildModuleGraphForRules(options); // build 1
  const idx = shardIndexForRelativePath("src/b/index.ts");
  const staleHash = JSON.parse(readFileSync(cachePath(root), "utf8")).shards[idx].hash;
  writeFileSync(b, 'import { a } from "../a/index.js"; export const b2 = a;\n');
  bump(b);
  buildModuleGraphForRules(options); // build 2: a normal, fully-written cache with a NEW hash for shard b
  const raced = JSON.parse(readFileSync(cachePath(root), "utf8"));
  expect(raced.shards[idx].hash).not.toBe(staleHash); // the shard really did change
  raced.shards[idx].hash = staleHash; // the racing writer's own, now-stale header
  writeFileSync(cachePath(root), JSON.stringify(raced));
  vi.clearAllMocks();
  const warm = facts(buildModuleGraphForRules(options)); // build 3
  expect(parsedFiles()).toEqual([b]);
  expect(warm).toEqual(facts(buildModuleGraph(options)));
}));

// The property this codec exists to keep true: whatever writeEdgeCache
// encodes across its own SHARD_COUNT shards, readEdgeCache decodes back
// into the exact same in-memory files map - covering an outside-root
// resolvedFile (a real `resolvedFile` can sit in an ancestor's own
// node_modules, past the project root), a builtin's own null resolution
// slot, `"unresolved"`, a real resolution with and without
// isExternalLibraryImport/packageName, every mode this project's own
// walker produces (undefined/CommonJS/ESNext-shaped), a legacy unreadable
// entry that the graph's reparse gate must reject, and every cached
// module-augmentation specifier with its resolution mode.
test("a shard's own encoding round-trips its entries exactly", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-edge-cache-roundtrip-")));
  try {
    await hegel.testAsync(async (tc) => {
      const candidatePaths = ["src/a/index.ts", "src/b/index.ts", "src/b/nested/leaf.ts", "src/c/index.ts", "src/c/other.ts"];
      const relPaths = [...new Set(tc.draw(gen.arrays(gen.sampledFrom(candidatePaths), { minSize: 1, maxSize: 5 })))];
      const specifiers = ["../b/index.js", "node:fs", "missing-pkg", "@scope/pkg", "./sibling.js"];
      const modes = [undefined, 1, 99] as const;
      const files: Record<string, CachedFileEntry> = {};
      for (const rel of relPaths) {
        const unreadable = tc.draw(gen.booleans());
        const importCount = unreadable ? 0 : tc.draw(gen.integers({ minValue: 0, maxValue: 4 }));
        const imports: CachedFileEntry["imports"] = [];
        const resolutions: Record<string, CachedResolution> = {};
        for (let i = 0; i < importCount; i++) {
          const specifier = tc.draw(gen.sampledFrom(specifiers));
          const mode = tc.draw(gen.sampledFrom(modes));
          const imp = { specifier, fromPosition: { line: i + 1, column: 3 },
            isTypeOnly: tc.draw(gen.booleans()), isDynamic: tc.draw(gen.booleans()), mode };
          imports.push(imp);
          const key = `${specifier}\u0000${mode ?? ""}`;
          const kind = tc.draw(gen.sampledFrom(["builtin", "unresolved", "internal", "external"] as const));
          if (kind === "builtin") continue; // no resolutions entry at all - the encoded null slot
          if (kind === "unresolved") { resolutions[key] = "unresolved"; continue; }
          if (kind === "internal") { resolutions[key] = { resolvedFile: join(root, "src/b/index.ts") }; continue; }
          resolutions[key] = { resolvedFile: join(root, "../outside/dep/index.d.ts"), isExternalLibraryImport: true, packageName: "@scope/pkg" };
        }
        const impliedNodeFormat = tc.draw(gen.sampledFrom(modes));
        const moduleAugmentationSpecifiers = tc.draw(gen.arrays(
          gen.tuples(gen.sampledFrom(specifiers), gen.sampledFrom(modes)), { maxSize: 3 },
        )).map(([specifier, mode]) => ({ specifier, mode }));
        files[join(root, rel)] = {
          mtimeMs: 1_700_000_000_000 + tc.draw(gen.integers({ minValue: 0, maxValue: 999 })) / 10,
          size: tc.draw(gen.integers({ minValue: 0, maxValue: 5000 })),
          optionsIndex: tc.draw(gen.integers({ minValue: 0, maxValue: 1 })),
          ...(impliedNodeFormat !== undefined ? { impliedNodeFormat } : {}),
          imports, unsupportedSyntaxCount: tc.draw(gen.integers({ minValue: 0, maxValue: 3 })),
          isScript: tc.draw(gen.booleans()), hasAmbientDeclarations: tc.draw(gen.booleans()),
          hasModuleAugmentation: moduleAugmentationSpecifiers.length > 0,
          moduleAugmentationSpecifiers,
          ...(unreadable ? { unreadable: true as const } : {}),
          resolutions,
        };
      }
      const path = join(root, "node_modules/.cache/archstrict/edges.json");
      writeEdgeCache(path, root,
        { archstrictVersion: "1", codeVersionHash: "h", typescriptVersion: "t", optionsTable: ["{}", '{"x":1}'], resolutionFingerprint: "f", files },
        undefined, new Set(Object.keys(files)), new Set(), true);
      const decoded = readEdgeCache(path, root);
      expect(decoded?.files).toEqual(files);
      rmSync(join(root, "node_modules"), { recursive: true, force: true });
    }, { testCases: 30 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.each(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"])(
  "%s changes invalidate cached resolutions without ever re-parsing an analyzed file",
  async (file) => project((root, options) => {
    const path = join(root, file);
    writeFileSync(path, "{}");
    buildModuleGraphForRules(options);
    vi.clearAllMocks();
    buildModuleGraphForRules(options);
    expect(ts.createSourceFile).not.toHaveBeenCalled();
    bump(path);
    buildModuleGraphForRules(options);
    // A resolution input moved, so every specifier is re-resolved - but a
    // lockfile has no bearing on any file's own impliedNodeFormat or
    // effective compiler options, so nothing is ever re-parsed for it.
    expect(ts.createSourceFile).not.toHaveBeenCalled();
    vi.clearAllMocks();
    rmSync(path);
    buildModuleGraphForRules(options);
    expect(ts.createSourceFile).not.toHaveBeenCalled();
    vi.clearAllMocks();
    writeFileSync(path, "{}");
    buildModuleGraphForRules(options);
    expect(ts.createSourceFile).not.toHaveBeenCalled();
  }),
);

// Unlike a lockfile, a package.json can change the very "type" a nearby
// file's own imports resolve under (see the dedicated test below for the
// root package.json case) - src/a/package.json sits nearer to
// src/a/index.ts than the project root's own package.json, so adding or
// removing it can change THAT file's own impliedNodeFormat and force its
// own reparse; it must never force src/b/index.ts's own reparse, which
// has no nearer package.json than the project root either way.
test("a nearer package.json appearing or disappearing re-parses only the file it is nearest to", async () => project((root, options) => {
  const path = join(root, "src/a/package.json");
  buildModuleGraphForRules(options);
  vi.clearAllMocks();
  writeFileSync(path, '{"type":"commonjs"}');
  buildModuleGraphForRules(options);
  expect(parsedFiles()).toEqual([join(root, "src/a/index.ts")]);
  vi.clearAllMocks();
  rmSync(path);
  buildModuleGraphForRules(options);
  expect(parsedFiles()).toEqual([join(root, "src/a/index.ts")]);
}));

// A package.json "type" edit changes which export condition (and so
// which real file) a specifier resolves to, with neither the importing
// file's own bytes nor its mtime touched - the cache must still notice,
// by comparing each file's own recomputed impliedNodeFormat against its
// stored one (edge-cache.ts's own header). Every file nearest to THIS
// package.json is reparsed to recompute its own imports' `mode` under
// the new format (ImportRecord's own header).
test("a package.json \"type\" change invalidates resolutions for the files nearest to it, without a whole-cache drop", async () => project((root, options) => {
  writeFileSync(join(root, "src/a/index.ts"), 'import { b } from "../b/index.js"; export const a = b;\n');
  const before = buildModuleGraphForRules(options);
  expect(before.unresolvedSpecifiers).toEqual([]);
  vi.clearAllMocks();
  // Flipping the project's own root package.json "type" to "commonjs"
  // changes both files' own impliedNodeFormat from ESM to CJS (neither
  // has a nearer package.json) - getModeForUsageLocation then resolves
  // "../b/index.js" under the CJS condition instead, which this
  // fixture's own package.json has no "require" condition for, so it
  // goes from resolved to unresolved.
  writeFileSync(join(root, "package.json"), '{"type":"commonjs"}');
  bump(join(root, "package.json"));
  const after = facts(buildModuleGraphForRules(options));
  expect(parsedFiles().sort()).toEqual([join(root, "src/a/index.ts"), join(root, "src/b/index.ts")].sort());
  expect(after).toEqual(facts(buildModuleGraph(options)));
}));

// A tsconfig edit changes the effective compiler options for every file
// under it - and so the `mode` walkFileImports recorded for each of that
// file's own specifiers (ImportRecord's own header) - so it is treated
// exactly like an edit to the file's own text: reparsed, not merely
// re-resolved. A root tsconfig.json reaches both files here; a leaf
// src/a/tsconfig.json reaches only src/a/index.ts.
test.each([
  ["tsconfig.json", ["src/a/index.ts", "src/b/index.ts"]],
  ["src/a/tsconfig.json", ["src/a/index.ts"]],
])("effective options in %s invalidate cached resolutions and re-parse exactly the files under it", async (file, affected) => project((root, options) => {
  buildModuleGraphForRules(options);
  const before = JSON.parse(readFileSync(cachePath(root), "utf8")).resolutionFingerprint;
  vi.clearAllMocks();
  writeFileSync(join(root, file), JSON.stringify({ compilerOptions: { noLib: true, types: [], paths: { alias: ["./src/b/index.ts"] } } }));
  const warm = facts(buildModuleGraphForRules(options));
  expect(parsedFiles().sort()).toEqual(affected.map((f) => join(root, f)).sort());
  expect(JSON.parse(readFileSync(cachePath(root), "utf8")).resolutionFingerprint).not.toBe(before);
  expect(warm).toEqual(facts(buildModuleGraph(options)));
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

test("a schema 9 edge cache is a miss under schema 10", async () => project((root, options) => {
  buildModuleGraphForRules(options);
  const path = cachePath(root);
  const cache = JSON.parse(readFileSync(path, "utf8"));
  cache.schema = 9;
  writeFileSync(path, JSON.stringify(cache));
  vi.clearAllMocks();
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).toHaveBeenCalled();
  expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe(10);
}));

// A corrupt cache file is a silent miss, never an error - the run behaves
// exactly like a fresh, uncached one, and its own successful write
// replaces the corrupt bytes.
test("a corrupt cache file is ignored, not an error", async () => project((root, options) => {
  const path = cachePath(root);
  mkdirSync(join(root, "node_modules/.cache/archstrict"), { recursive: true });
  writeFileSync(path, "{not json");
  const graph = buildModuleGraphForRules(options);
  expect(graph.edges.some((edge) => edge.toModule === "b")).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe(10);
}));

test("package exports changes refresh both target edges and derived surfaces, re-resolving without re-parsing the unedited importer", async () => project((root, options) => {
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
  expect(parsedFiles()).toEqual([]); // b/index.ts itself is unchanged - only its resolution moved
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
  "an unreadable root file is invisible on repeated cached builds",
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
      // Reading fails before parsing, but the missing cache entry makes the
      // second build retry the file rather than reuse an empty answer.
      expect(ts.createSourceFile).not.toHaveBeenCalled();
      expect(facts(warm)).toEqual(facts(cold));
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }),
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable file is retried after chmod changes only its permissions",
  async () => project(async (root, options) => {
    const unreadable = join(root, "src/a/secret.ts");
    writeFileSync(unreadable, 'import { b } from "../b/index.js"; export const secret = b;\n');
    chmodSync(unreadable, 0o000);
    try {
      const first = buildModuleGraphForRules(options);
      expect(first.modules.get("a")?.files).not.toContain(unreadable);
      expect(readCache(root).files[unreadable]).toBeUndefined();

      chmodSync(unreadable, 0o644);
      vi.clearAllMocks();
      const retried = buildModuleGraphForRules(options);
      expect(parsedFiles()).toContain(unreadable);
      expect(retried.modules.get("a")?.files).toContain(unreadable);
      expect(retried.edges.some((edge) => edge.fromFile === unreadable)).toBe(true);
      expect(facts(retried)).toEqual(facts(buildModuleGraph(options)));
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }),
);

// A cache hit's own rule 6 must never rebuild the whole graph through a
// second, uncached pass just to reach a Program. Proven here with a
// THIRD, uninvolved module (`c`, imported by nothing, importing nothing)
// whose own parse stays cached: if reaching `program`/`checker` on a
// cache hit re-walked every project file instead of using this build's
// own already-computed edges and flags, `c`'s own file would be
// re-parsed even though rule 6's own closure never needs it.
test("check <file> on a cache hit reaches rule 6's Program without re-parsing a file outside its closure", async () => project(async (root, options) => {
  // c/index.ts is module c's own surface (always a closure root, so it
  // would be reparsed by a correct build too); c/internal.ts is neither a
  // surface nor reachable from any edge or export chain, so it is the one
  // file a correct closure never needs - if reaching `program`/`checker`
  // on a cache hit rebuilt through a second, uncached pass, it would be
  // re-parsed anyway, along with every other project file.
  mkdirSync(join(root, "src/c"), { recursive: true });
  writeFileSync(join(root, "src/c/index.ts"), "export const c = 1;\n");
  writeFileSync(join(root, "src/c/internal.ts"), "export const secret = 1;\n");
  const declaredModules = [...options.declaredModules, { name: "c", glob: "src/c/**" }];
  writeFileSync(join(root, "archstrict.config.ts"),
    `export default ${JSON.stringify({ declaredModules, because: "test architecture", classify: [], exclude: ["*.ts"] })};`);
  const withC = { ...options, declaredModules };
  buildModuleGraphForRules(withC); // warm the cache
  vi.clearAllMocks();
  const result = await check(root);
  expect(result.typeLeaks).not.toBeNull(); // rule 6 actually ran
  const internal = join(root, "src/c/internal.ts");
  expect(parsedFiles()).not.toContain(internal);
}));

// project-only source files TypeScript's own dependency resolution pulled
// into the Program legitimately (a real `import type { Dep } from
// "some-dep"`), never counted as part of "the closure" (buildTypeClosure's
// own job is project files, not node_modules) or excluded on the other
// side by accident.
function realFileCount(program: ts.Program): number {
  return program.getSourceFiles().filter((f) => !f.fileName.includes("node_modules")).length;
}

// rule 6's own Program must hold exactly the closure's own real files -
// never more (an accidental whole-project rebuild) and never fewer (a
// file the closure named but the Program failed to load) -
// on the cold path AND on both a cache miss and a cache hit of the
// cached path, so a warm `check` cannot silently grow the Program past
// what a cold one would build for the identical project.
test("a check's Program source-file count (excluding node_modules) equals the closure size, cold and cached", async () => project((root, options) => {
  mkdirSync(join(root, "node_modules/some-dep"), { recursive: true });
  writeFileSync(join(root, "node_modules/some-dep/package.json"), '{"name":"some-dep","version":"1.0.0","types":"index.d.ts"}');
  writeFileSync(join(root, "node_modules/some-dep/index.d.ts"), "export interface Dep {}\n");
  writeFileSync(join(root, "src/a/index.ts"),
    'import { b } from "../b/index.js"; import type { Dep } from "some-dep"; export const a = b; export type D = Dep;\n');

  // Ground truth: the closure's own real (project-only) file list,
  // captured through the cold path's own test hook.
  const prepared = prepareGraph(options);
  let closureReal = -1;
  const cold = buildPreparedGraph(prepared, {
    onClosureRoundForTests: (_round, files) => { closureReal = files.filter((f) => !f.includes("node_modules")).length; },
  });
  const coldReal = realFileCount(cold.program); // lazy getter - triggers the hook above
  expect(closureReal).toBeGreaterThan(0);
  expect(coldReal).toBe(closureReal);

  const cacheMiss = buildModuleGraphForRules(options);
  expect(realFileCount(cacheMiss.program)).toBe(closureReal);
  const cacheHit = buildModuleGraphForRules(options);
  expect(realFileCount(cacheHit.program)).toBe(closureReal);
}));

// Every walked file's own specifiers are resolved, whether or not it
// currently belongs to a declared module - moving a file into a module
// through a `declaredModules` edit alone finds a real resolution record
// already there, not a gap read back as "unresolved" forever.
test("a file joining a module through a declaredModules edit gets its edges resolved, not read back as unresolved", async () => project((root, options) => {
  writeFileSync(join(root, "src/b/x.ts"), 'import { a } from "../a/index.js"; export const x = a;\n');
  const withoutB = { ...options, declaredModules: [options.declaredModules[0]!] };
  buildModuleGraphForRules(withoutB);
  const withB = { ...options, declaredModules: [...withoutB.declaredModules, { name: "b", glob: "src/b/**" }] };
  const warm = facts(buildModuleGraphForRules(withB));
  const cold = facts(buildModuleGraph(withB));
  expect(warm).toEqual(cold);
  expect(warm.unresolvedSpecifierCount).toBe(0);
}));

// The resolvable-file fingerprint covers every resolvable extension
// outside node_modules, including an excluded directory - it notices a
// new .d.ts inside one, a generated api/*.d.ts a project's own
// config.exclude keeps out of analysis but not out of what an import
// elsewhere can resolve to.
test("a .d.ts appearing inside an excluded directory resolves a type-only import that named it", async () => project((root, options) => {
  writeFileSync(join(root, "src/a/index.ts"), 'import type { G } from "../gen/api.js"; export type T = G;\n');
  const o = { ...options, exclude: ["src/gen/**"] };
  buildModuleGraphForRules(o);
  mkdirSync(join(root, "src/gen"));
  writeFileSync(join(root, "src/gen/api.d.ts"), "export interface G {}\n");
  const warm = facts(buildModuleGraphForRules(o));
  const cold = facts(buildModuleGraph(o));
  expect(warm).toEqual(cold);
}));

// The same fingerprint must notice an excluded .ts appearing too - an
// excluded test-helper file a real import can still name once it exists,
// even though config.exclude keeps it out of analysis.
test("an excluded .ts file appearing resolves an import that named it", async () => project((root, options) => {
  writeFileSync(join(root, "src/a/index.ts"), 'import { h } from "./helper.js"; export const x = h;\n');
  const o = { ...options, exclude: ["**/helper.ts"] };
  buildModuleGraphForRules(o);
  writeFileSync(join(root, "src/a/helper.ts"), "export const h = 1;\n");
  const warm = facts(buildModuleGraphForRules(o));
  const cold = facts(buildModuleGraph(o));
  expect(warm).toEqual(cold);
}));

// A package installed straight into node_modules, with no lockfile at
// all (a real, legal state - `npm link`, or a manual install before a
// lockfile is regenerated) must still be noticed: nothing else this
// cache reads (no package.json outside node_modules, no lockfile) moves
// when this happens.
test("a package installed into node_modules with no lockfile resolves an import that named it", async () => project((root, options) => {
  writeFileSync(join(root, "src/a/index.ts"), 'import type { P } from "pkg"; export type T = P;\n');
  buildModuleGraphForRules(options);
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/package.json"), '{"name":"pkg","version":"1.0.0","types":"index.d.ts"}');
  writeFileSync(join(root, "node_modules/pkg/index.d.ts"), "export interface P {}\n");
  const warm = facts(buildModuleGraphForRules(options));
  const cold = facts(buildModuleGraph(options));
  expect(warm).toEqual(cold);
}));

// TypeScript's own bare-specifier resolution walks every ancestor
// directory's own node_modules up to the filesystem root, regardless of
// where a lockfile happens to sit - a package installed only into an
// ancestor above the project's own lockfile still resolves for real, so
// the fingerprint must reach that far too.
test("a package installed into an ancestor's node_modules, past the project's own lockfile, resolves an import that named it", async () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-edge-cache-anc-")));
  const root = join(top, "proj");
  try {
    mkdirSync(join(root, "src/a"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext"}}');
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "package-lock.json"), "{}");
    writeFileSync(join(root, "src/a/index.ts"), 'import type { P } from "anc"; export type T = P;\n');
    const options: BuildOptions = { projectRoot: root, declaredModules: [{ name: "a", glob: "src/a/**" }], exclude: [] };
    buildModuleGraphForRules(options);
    mkdirSync(join(top, "node_modules/anc"), { recursive: true });
    writeFileSync(join(top, "node_modules/anc/package.json"), '{"name":"anc","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(join(top, "node_modules/anc/index.d.ts"), "export interface P {}\n");
    const warm = facts(buildModuleGraphForRules(options));
    const cold = facts(buildModuleGraph(options));
    expect(warm).toEqual(cold);
    expect(warm.unresolvedSpecifiers).toEqual([]);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// A workspace member's own node_modules (packages/app/node_modules, a
// pnpm/npm workspace's own real layout) is not an ancestor of the
// project root - it sits INSIDE the project tree, so only the
// project-tree walk (not the ancestor chain) ever meets it. The
// project's own lockfile stays untouched the whole time.
test("a package installed into a nested workspace member's own node_modules resolves an import that named it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-edge-cache-workspace-")));
  try {
    mkdirSync(join(root, "packages/app/src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext"}}');
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "pnpm-lock.yaml"), "x");
    writeFileSync(join(root, "packages/app/package.json"), '{"name":"app","type":"module"}');
    writeFileSync(join(root, "packages/app/src/index.ts"), 'import type { P } from "dep"; export type T = P;\n');
    const options: BuildOptions = { projectRoot: root, declaredModules: [{ name: "app", glob: "packages/app/**" }], exclude: [] };
    buildModuleGraphForRules(options);
    const real = join(root, "node_modules/.pnpm/dep@1.0.0/node_modules/dep");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "package.json"), '{"name":"dep","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(join(real, "index.d.ts"), "export interface P {}\n");
    mkdirSync(join(root, "packages/app/node_modules"), { recursive: true });
    symlinkSync(real, join(root, "packages/app/node_modules/dep"));
    const warm = facts(buildModuleGraphForRules(options));
    const cold = facts(buildModuleGraph(options));
    expect(warm).toEqual(cold);
    expect(warm.unresolvedSpecifiers).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A dot-prefixed entry appearing directly under node_modules (this
// project's own ".cache" once it writes its own cache file, or another
// tool's ".vite"/".vitest") is never a real package - a second, no-op
// warm run must not read it as one and re-resolve every specifier over
// nothing real having changed.
test("a second no-op warm run does not re-resolve, even after node_modules gains a dot-prefixed directory", async () => project((root, options) => {
  buildModuleGraphForRules(options); // writes node_modules/.cache/archstrict itself
  vi.clearAllMocks();
  buildModuleGraphForRules(options);
  expect(ts.createSourceFile).not.toHaveBeenCalled();
  const before = JSON.parse(readFileSync(cachePath(root), "utf8")).resolutionFingerprint;
  mkdirSync(join(root, "node_modules/.vite"), { recursive: true });
  buildModuleGraphForRules(options);
  expect(JSON.parse(readFileSync(cachePath(root), "utf8")).resolutionFingerprint).toBe(before);
}));

test("filterToFile makes no realpath call per violation", async () => project(async (root) => {
  const a = join(root, "src/a/index.ts");
  const b = join(root, "src/b/internal.ts");
  writeFileSync(b, "export const secret = 1;\n");
  writeFileSync(a, 'import { secret } from "../b/internal.js"; export const a = secret;\n'); // a public-surface bypass
  const result = await check(root);
  vi.clearAllMocks();
  const target = join(root, "src/a/index.ts");
  filterToFile(result, target);
  expect(calls.realpath).toHaveBeenCalledTimes(1); // one call for `target`, none per violation
}));

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

// facts() plus each module's own type-leak findings - this property
// test's own oracle, not the module-scoped `facts()` every other test in
// this file uses (which stays cheap: it never builds a Program). This
// one does, deliberately: rule 6 must agree between a cold build and a
// cache-backed one exactly as much as the edge graph does.
function factsWithTypeLeaks(graph: ModuleGraph) {
  return { ...facts(graph), typeLeaks: checkTypeLeaks(graph).map((v) => v.evidence).sort() };
}

// The property this whole cache exists to keep true: an incremental,
// cache-backed build agrees with a cold, no-cache build after ANY
// sequence of real filesystem operations, not merely the single-operation
// cases above. Bounded like test/init.property.test.ts's own P8 (a small,
// fixed testCases count plus an explicit timeout): each case runs several
// full cold rebuilds as its own oracle, and the default case count is
// slow at that cost.
type Op = "editImports" | "addFile" | "deleteFile" | "renameFile" | "editNestedType" | "editTsconfigPaths" |
  "touch" | "toggleResolvableSibling" | "toggleModuleMembership" | "toggleExcludedResolvable" |
  "toggleDistResolvable" | "toggleNodeModulesPackage" | "toggleRootType";
const OPS: Op[] = ["editImports", "addFile", "deleteFile", "renameFile", "editNestedType", "editTsconfigPaths",
  "touch", "toggleResolvableSibling", "toggleModuleMembership", "toggleExcludedResolvable",
  "toggleDistResolvable", "toggleNodeModulesPackage", "toggleRootType"];

test("an incremental, cache-backed build equals a cold build after any sequence of real edits", async () => {
  await hegel.testAsync(async (tc) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-edge-cache-prop-")));
    try {
      const declaredModules = [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }];
      mkdirSync(join(root, "src/a"), { recursive: true });
      mkdirSync(join(root, "src/b/nested"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), 'import { b } from "../b/index.js"; export const a = b;\n');
      writeFileSync(join(root, "src/b/index.ts"), "export const b = 1;\n");
      writeFileSync(join(root, "src/b/nested/leaf.ts"), "export const leaf = 1;\n");
      writeFileSync(join(root, "src/b/nested/package.json"), '{"type":"module"}');
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext"}}');
      const bothModules = declaredModules;
      const onlyA = [declaredModules[0]!];
      let currentDeclaredModules = bothModules;
      const exclude = ["src/excluded/**"];
      let addedCount = 0;
      let added: string | undefined;
      // A non-analyzed, resolvable file (never parsed - see
      // RESOLVABLE_EXTENSIONS' own header) whose mere existence, not
      // content, can flip "../b/extra.js" between resolved and
      // unresolved with no analyzed file touched at all.
      const sibling = join(root, "src/b/extra.js");
      const excludedResolvable = join(root, "src/excluded/gen.d.ts");
      const distResolvable = join(root, "dist/built.js");
      const nmPackageJson = join(root, "node_modules/pkg/package.json");
      const nmIndex = join(root, "node_modules/pkg/index.d.ts");

      // `bump` sometimes moves a file's own mtime forward and sometimes
      // leaves it exactly as it was - a real edit an editor's own atomic
      // save can produce either way. Every op below that calls this
      // still writes a size-changing edit (never the accepted same-size,
      // restored-mtime gap the module header documents), so the
      // equivalence property holds regardless of which one this draw
      // picks.
      const bumpOrNot = (path: string) => { if (tc.draw(gen.booleans())) bump(path); };

      const ops = tc.draw(gen.arrays(gen.sampledFrom(OPS), { minSize: 1, maxSize: 6 }));
      for (const op of ops) {
        if (op === "editImports") {
          const body = tc.draw(gen.sampledFrom([
            'import { b } from "../b/index.js"; export const a = b;',
            'export { b } from "../b/index.js";',
            'import type { B } from "../b/index.js"; export const a = 1;',
            'import "missing-package"; export const a = 1;',
            'import { extra } from "../b/extra.js"; export const a = extra;',
          ]));
          writeFileSync(join(root, "src/a/index.ts"), `${body}\n`);
          bumpOrNot(join(root, "src/a/index.ts"));
        } else if (op === "toggleResolvableSibling") {
          if (existsSync(sibling)) rmSync(sibling);
          else writeFileSync(sibling, "export const extra = 1;\n");
        } else if (op === "toggleExcludedResolvable") {
          if (existsSync(excludedResolvable)) rmSync(excludedResolvable);
          else { mkdirSync(dirname(excludedResolvable), { recursive: true }); writeFileSync(excludedResolvable, "export interface Gen {}\n"); }
        } else if (op === "toggleDistResolvable") {
          if (existsSync(distResolvable)) rmSync(distResolvable);
          else writeFileSync(distResolvable, "export const built = 1;\n");
        } else if (op === "toggleNodeModulesPackage") {
          if (existsSync(nmPackageJson)) rmSync(dirname(nmPackageJson), { recursive: true, force: true });
          else {
            mkdirSync(dirname(nmPackageJson), { recursive: true });
            writeFileSync(nmPackageJson, '{"name":"pkg","version":"1.0.0","types":"index.d.ts"}');
            writeFileSync(nmIndex, "export interface Pkg {}\n");
          }
        } else if (op === "toggleModuleMembership") {
          currentDeclaredModules = currentDeclaredModules === bothModules ? onlyA : bothModules;
        } else if (op === "toggleRootType") {
          const pkg = join(root, "package.json");
          const type = tc.draw(gen.sampledFrom(["module", "commonjs"]));
          writeFileSync(pkg, JSON.stringify({ type }));
          bumpOrNot(pkg);
        } else if (op === "addFile") {
          addedCount++;
          added = join(root, `src/b/added-${addedCount}.ts`);
          writeFileSync(added, "export const added = 1;\n");
        } else if (op === "deleteFile") {
          if (added !== undefined) { rmSync(added, { force: true }); added = undefined; }
        } else if (op === "renameFile") {
          if (added !== undefined) {
            const target = `${added}.renamed.ts`;
            renameSync(added, target);
            added = target;
          }
        } else if (op === "editNestedType") {
          const type = tc.draw(gen.sampledFrom(["module", "commonjs"]));
          writeFileSync(join(root, "src/b/nested/package.json"), JSON.stringify({ type }));
          bumpOrNot(join(root, "src/b/nested/package.json"));
        } else if (op === "editTsconfigPaths") {
          const withPaths = tc.draw(gen.booleans());
          writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
            noLib: true, types: [], module: "nodenext",
            ...(withPaths ? { paths: { "@x/*": ["./src/b/*"] } } : {}),
          } }));
          bumpOrNot(join(root, "tsconfig.json"));
        } else if (op === "touch") {
          bump(join(root, "src/a/index.ts"));
        }

        const options: BuildOptions = { projectRoot: root, declaredModules: currentDeclaredModules, exclude };
        const warm = factsWithTypeLeaks(buildModuleGraphForRules(options));
        const cold = factsWithTypeLeaks(buildModuleGraph(options));
        expect(warm).toEqual(cold);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { testCases: 20 });
}, 60_000);

// A sibling .d.ts is never parsed or walked (RESOLVABLE_EXTENSIONS' own
// header) - only its existence can move a specifier from unresolved to
// resolved, with no analyzed file, package.json, or lockfile touched.
// Without listResolvableFiles' own contribution to resolutionFingerprint,
// a warm build would keep replaying the earlier, stale "unresolved"
// answer forever.
test("adding a sibling .d.ts resolves a specifier that was unresolved, on the next warm build", async () => project((root, options) => {
  const a = join(root, "src/a/index.ts");
  writeFileSync(a, 'import { Foo } from "../b/foo.js"; export type T = Foo;\n');
  const before = buildModuleGraphForRules(options);
  expect(before.unresolvedSpecifiers).toContain("../b/foo.js");
  const foo = join(root, "src/b/foo.d.ts");
  writeFileSync(foo, "export interface Foo {}\n");
  vi.clearAllMocks();
  const after = buildModuleGraphForRules(options);
  expect(parsedFiles()).toEqual([]); // a.index.ts's own text is unchanged
  expect(after.edges.some((e) => e.specifier === "../b/foo.js" && e.resolvedFile === foo)).toBe(true);
  expect(after.unresolvedSpecifiers).not.toContain("../b/foo.js");
}));
