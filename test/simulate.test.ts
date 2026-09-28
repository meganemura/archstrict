// Responsibility: compare in-memory changes with real filesystem changes and the full rule pipeline.
// Boundary: disposable projects only; compiler spies observe real builds without replacing analysis.
import { expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as graphs from "../src/module-graph.js";
import { applyTodo, check, loadConfig, runRules, type AnyViolation } from "../src/verbs/check.js";
import { simulate, formatSimulateText, type Change } from "../src/verbs/simulate.js";
import { fingerprintOf, writeTodoFile } from "../src/todo-store.js";

function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
async function project(run: (root: string, parent: string) => Promise<void>) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-simulate-")));
  const root = join(parent, "project");
  try {
    put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "nodenext", target: "esnext" } }));
    put(root, "package.json", '{"type":"module"}');
    configure(root);
    put(root, "src/a/index.ts", "export const value = 1;");
    put(root, "src/b/index.ts", "export const value = 2;");
    await run(root, parent);
  } finally { vi.restoreAllMocks(); rmSync(parent, { recursive: true, force: true }); }
}
function configure(root: string, extra: object = {}) {
  put(root, "archstrict.config.ts", `export default ${JSON.stringify({
    declaredModules: ["a", "b"].map(name => ({ name, glob: `src/${name}/**` })),
    exclude: ["*.ts", "src/excluded/**"], because: "Keep module boundaries explicit.", ...extra,
  })};`);
}
function snapshot(root: string): unknown[] {
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const path = join(root, entry.name);
    const stat = statSync(path);
    return [entry.name, stat.mtimeMs, entry.isDirectory() ? snapshot(path) : readFileSync(path).toString("base64")];
  });
}
function normalize<T>(value: T, root: string): T {
  return JSON.parse(JSON.stringify(value).split(root).join("<root>")) as T;
}
function sorted<T>(values: T[]): T[] {
  return [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function cold(root: string) {
  const config = await loadConfig(join(root, "archstrict.config.ts"));
  const graph = graphs.buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules!, exclude: config.exclude, surface: config.surface });
  return { graph, result: applyTodo(graph, config, runRules(graph, config)) };
}
function delta(before: AnyViolation[], after: AnyViolation[]) {
  const old = new Set(before.map(fingerprintOf)), current = new Set(after.map(fingerprintOf));
  return { added: sorted(after.filter(v => !old.has(fingerprintOf(v)))),
    resolved: sorted(before.filter(v => !current.has(fingerprintOf(v)))),
    unchangedCount: before.filter(v => current.has(fingerprintOf(v))).length };
}
async function compareCold(root: string, parent: string, changes: Change[]) {
  const before = await cold(root);
  const diskBefore = snapshot(root);
  const result = await simulate(root, changes, { wholeProject: true });
  const copy = join(parent, "copy");
  cpSync(root, copy, { recursive: true });
  for (const change of changes) {
    if (change.content === null) rmSync(join(copy, change.path), { force: true });
    else put(copy, change.path, change.content);
  }
  const after = await cold(copy);
  expect({ ...normalize(result, root), added: sorted(normalize(result.added, root)), resolved: sorted(normalize(result.resolved, root)) })
    .toEqual({ mode: "whole-project", ...delta(normalize(before.result.violations, root), normalize(after.result.violations, copy)) });
  expect(snapshot(root)).toEqual(diskBefore);
  return { result, afterGraph: after.graph, after: after.result };
}

test("two edits together introduce a new cycle that neither edit creates alone", () => project(async (root, parent) => {
  const changes = [{ path: "src/a/index.ts", content: 'import "../b/index.js"; export const value = 1;' },
    { path: "src/b/index.ts", content: 'import "../a/index.js"; export const value = 2;' }];
  for (const change of changes) expect((await simulate(root, [change])).added.some(v => v.rule === "cycle")).toBe(false);
  const { result } = await compareCold(root, parent, changes);
  expect(result.added.some(v => v.rule === "cycle")).toBe(true);
}));

test("scoped simulation reports changed-file violations and whole-project mode keeps project findings", () => project(async root => {
  put(root, "src/a/index.ts", 'import { hidden } from "../b/private.js"; export const value = hidden;');
  const changes = [{ path: "src/b/private.ts", content: "export const hidden = 1;" }];

  const scoped = await simulate(root, changes);
  expect(scoped.mode).toBe("scoped");
  expect(scoped.added).toEqual([]);

  const whole = await simulate(root, changes, { wholeProject: true });
  expect(whole.mode).toBe("whole-project");
  expect(whole.added.some(v => v.rule === "public-surface-bypass" && v.path.endsWith("src/a/index.ts"))).toBe(true);
}));

test("generated scoped results equal whole-project findings that land on changed files", async () => {
  await hegel.testAsync(async tc => project(async root => {
    put(root, "src/b/private.ts", "export const hidden = 1;");
    const surface = tc.draw(gen.booleans());
    const bypass = tc.draw(gen.booleans());
    const path = surface ? "src/a/index.ts" : "src/a/worker.ts";
    if (!surface) put(root, path, "export const before = 1;");
    const content = bypass
      ? 'import { hidden } from "../b/private.js"; export const value = hidden;'
      : 'import { value } from "../b/index.js"; export const clean = value;';
    const changes = [{ path, content }];
    const scoped = await simulate(root, changes);
    const whole = await simulate(root, changes, { wholeProject: true });
    const target = join(root, path);
    const keys = (values: AnyViolation[]) => values.map(fingerprintOf).sort();
    expect(keys(scoped.added)).toEqual(keys(whole.added.filter(v => v.path === target)));
    expect(keys(scoped.resolved)).toEqual(keys(whole.resolved.filter(v => v.path === target)));
  }), { testCases: 20 });
});

test("removing the last deprecated edge resolves its excess and reports its now-empty declaration", () => project(async (root, parent) => {
  configure(root, { deprecated: [{ from: "a", to: "b", count: 0, because: "Remove this dependency." }] });
  put(root, "src/a/index.ts", 'import "../b/index.js";');
  const { result } = await compareCold(root, parent, [{ path: "src/a/index.ts", content: "export {};" }]);
  expect(result.resolved.some(v => v.rule === "deprecated-edge-increased")).toBe(true);
  expect(result.added.some(v => v.rule === "empty-rule-set" && v.evidence.includes("deprecated edge 'a -> b'"))).toBe(true);
}));

test("a config's top-level surface makes main.ts, not index.ts, the public surface for an added import", () => project(async (root, parent) => {
  configure(root, { surface: "main.ts" });
  put(root, "src/b/main.ts", "export const value = 3;");
  put(root, "src/a/index.ts", 'import { value } from "../b/main.js"; export const clean = value;');
  const clean = await check(root);
  expect(clean.violations.some(v => v.rule === "public-surface-bypass")).toBe(false);
  const { result } = await compareCold(root, parent, [{
    path: "src/a/index.ts",
    content: 'import { value } from "../b/main.js"; import { value as v2 } from "../b/index.js"; export const clean = value; export const bad = v2;',
  }]);
  expect(result.added.some(v => v.rule === "public-surface-bypass")).toBe(true);
}));

test("a proposed change to the top-level surface decides whether a newly added declaration file becomes a root", () => project(async (root, parent) => {
  const configChange = {
    path: "archstrict.config.ts",
    content: `export default ${JSON.stringify({
      declaredModules: ["a", "b"].map(name => ({ name, glob: `src/${name}/**` })),
      exclude: ["*.ts", "src/excluded/**"], because: "Keep module boundaries explicit.",
      surface: "api.d.ts",
    })};`,
  };
  const changes = [configChange, { path: "src/b/api.d.ts", content: "export interface Shape { value: number }" }];
  const { afterGraph } = await compareCold(root, parent, changes);
  expect(afterGraph.program.getRootFileNames()).toContain(join(afterGraph.rootDir, "src/b/api.d.ts"));
}));

test("deleting a target removes the real edge and its public-surface violation", () => project(async (root, parent) => {
  put(root, "src/b/private.ts", "export const value = 1;");
  put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
  const { result, afterGraph } = await compareCold(root, parent, [{ path: "src/b/private.ts", content: null }]);
  expect(result.resolved.some(v => v.rule === "public-surface-bypass")).toBe(true);
  expect(afterGraph.edges).toEqual([]);
  expect(afterGraph.unresolvedSpecifiers).toContain("../b/private.js");
}));

test("creation in a new directory becomes a root and reports its new violation", () => project(async (root, parent) => {
  const { result, afterGraph } = await compareCold(root, parent, [{ path: "src/new/deep/file.ts", content: "export {};" }]);
  // rule 6's own Program is the type closure (type-closure.ts), not
  // every analyzed file - this plain, unreferenced file (no surface, no
  // type reference into it, no ambient body) is correctly outside that
  // closure. "Became a root" is checked the way the edge walk itself
  // reports it instead: a real file the scan reached that matches no
  // declared module, exactly what makes it an uncovered-module violation
  // below.
  expect(afterGraph.outsideFiles).toContain(join(afterGraph.rootDir, "src/new/deep/file.ts"));
  expect(result.added.some(v => v.rule === "uncovered-module")).toBe(true);
  expect(existsSync(join(root, "src/new"))).toBe(false);
}));

test("an imported declaration file's overlay text reaches the closure Program", () => project(async (root, parent) => {
  put(root, "src/a/index.ts", 'import type { Hidden } from "./types.js"; export const value: Hidden = { value: 1 };');
  put(root, "src/a/types.d.ts", "export interface Hidden { value: number }");
  const content = "export interface Hidden { value: number; optional?: string }";
  const { afterGraph } = await compareCold(root, parent, [{ path: "src/a/types.d.ts", content }]);
  // types.d.ts is never in rootNames (a hand-authored .d.ts is excluded
  // from analysis by default), yet Hidden is referenced by an explicit
  // type annotation on a declaration this surface exports - the closure
  // reaches it and must give it its own explicit Program root (unlike a
  // whole-project Program, `noResolve: true` means nothing enters the
  // Program by resolution alone). Its overlay text must still be the one
  // this check actually cares about.
  expect(afterGraph.program.getRootFileNames()).toContain(join(afterGraph.rootDir, "src/a/types.d.ts"));
  expect(afterGraph.program.getSourceFile(join(afterGraph.rootDir, "src/a/types.d.ts"))!.text).toBe(content);
}));

test("simulation preserves disk bytes, timestamps, todo, and a subsequent real check", () => project(async root => {
  put(root, "src/b/private.ts", "export const value = 1;");
  put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
  const violation = (await check(root)).violations.find(v => v.rule === "public-surface-bypass")!;
  expect(violation.rule).toBe("public-surface-bypass");
  if (violation.rule !== "public-surface-bypass") throw new Error("expected surface violation");
  writeTodoFile(root, new Map([[violation.todoModule, [{ rule: violation.rule, path: violation.path, evidence: violation.evidence }]]]));
  const before = JSON.stringify(await check(root));
  const bytes = snapshot(root);
  const result = await simulate(root, [{ path: "src/a/index.ts", content: "export {};" }]);
  expect(result.added.some(v => v.rule === "stale-todo")).toBe(true);
  expect(result.resolved).toEqual([]);
  expect(snapshot(root)).toEqual(bytes);
  expect(JSON.stringify(await check(root))).toBe(before);
  expect(snapshot(root)).toEqual(bytes);
}));

test("paths through a symlinked project root resolve with missing directory segments", () => project(async (root, parent) => {
  const alias = join(parent, "alias");
  symlinkSync(root, alias);
  const relative = [{ path: "src/new/nested/file.ts", content: "export {};" }];
  expect(await simulate(alias, relative)).toEqual(await simulate(root, relative));
  expect(await simulate(alias, [{ ...relative[0]!, path: join(alias, relative[0]!.path) }])).toEqual(await simulate(root, relative));
}));

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
function cli(root: string, input: string, args = ["--json"]) {
  return spawnSync(process.execPath, [cliPath, "simulate", ...args], { cwd: root, encoding: "utf8", input });
}
test("CLI reads one JSON body and renders full violations with the correct exit status", () => project(async root => {
  const changes = [{ path: "src/loose.ts", content: "export {};" }];
  const result = await simulate(root, changes);
  const json = cli(root, JSON.stringify({ changes }));
  expect(json.status).toBe(1);
  expect(JSON.parse(json.stdout)).toEqual(result);
  expect(Object.keys(JSON.parse(json.stdout)).sort()).toEqual(["added", "mode", "resolved", "unchangedCount"]);
  const text = cli(root, JSON.stringify({ changes }), []);
  expect(text.status).toBe(1);
  expect(text.stdout).toBe(formatSimulateText(result));
  expect(text.stdout).toContain("[uncovered-module]");
  expect(text.stdout).toContain("because:");
  expect(text.stdout).toContain("do:");
  const clean = cli(root, '{"changes":[]}');
  expect(clean.status).toBe(0);
  expect(JSON.parse(clean.stdout)).toEqual({ mode: "scoped", added: [], resolved: [], unchangedCount: 0 });
}));

test("CLI rejects malformed changes, duplicate paths, flags, and missing configuration", () => project(async root => {
  for (const body of ["{", "{}", '{"changes":[{}]}', '{"changes":[null]}', '{"changes":[{"path":"a","content":2}]}',
    '{"changes":[{"path":"a","content":""},{"path":"./a","content":null}]}']) {
    const result = cli(root, body);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toEqual(expect.any(String));
  }
  expect(cli(root, '{"changes":[]}', ["--apply", "--json"]).status).toBe(1);
  put(root, "archstrict.config.ts", 'export default { because: "test" };');
  expect(JSON.parse(cli(root, '{"changes":[]}').stdout).error).toContain("declaredModules");
}));

// Repeated compiler builds bound the case count; each case guarantees every required filesystem transition.
test("generated change sets preserve cold graph facts and full rule results", async () => {
  const counts = { cases: 0, surface: 0, excluded: 0, newDirectory: 0, lastFile: 0, modified: 0 };
  await hegel.testAsync(async tc => project(async (root, parent) => {
    const names = ["a", "b", ...tc.draw(gen.arrays(gen.text({ alphabet: "cdefgh", minSize: 1, maxSize: 5 }), { unique: true }))];
    const declaredModules = [...names, "surface", "doomed"].map(name => ({ name, glob: `src/${name}/**` }));
    configure(root, { declaredModules,
      classify: names.map(name => ({ glob: `src/${name}/**`, tags: [`role:${name}`] })),
      edges: { allowDeny: [{ source: "role:a", targetNamespace: "role", deny: [tc.draw(gen.sampledFrom(names))], because: "Separate roles." }],
        point: [{ from: "src/a/**", to: "src/b/**", because: "Keep this boundary." }] },
      deprecated: [{ from: "a", to: "b", count: tc.draw(gen.integers({ minValue: 0, maxValue: 3 })), because: "Reduce coupling." }],
    });
    const source = () => tc.draw(gen.arrays(gen.sampledFrom(names))).map((target, index) => {
      const form = tc.draw(gen.sampledFrom(["static", "type", "dynamic", "private"]));
      if (form === "type") return `import type { Shape as T${index} } from "../${target}/index.js";`;
      if (form === "dynamic") return `void import("../${target}/index.js");`;
      return `import "../${target}/${form === "private" ? "private" : "index"}.js";`;
    }).join("\n") + "\nexport interface Shape { value: number }\nexport const value = 1;";
    const changes: Change[] = [];
    for (const name of names) {
      put(root, `src/${name}/index.ts`, source());
      put(root, `src/${name}/private.ts`, "export const internal = 1;");
      const action = tc.draw(gen.sampledFrom(["modify", "delete", "keep"]));
      if (action !== "keep") changes.push({ path: `src/${name}/index.ts`, content: action === "delete" ? null : source() });
    }
    put(root, "src/surface/private.ts", "export const value = 1;");
    put(root, "src/doomed/last.ts", 'import "../a/index.js";');
    put(root, "src/a/watch.ts", 'import "../surface/index.js"; import "./new/deep/file.js";');
    changes.push(
      { path: "src/surface/index.ts", content: 'export { value } from "./private.js";' },
      { path: "src/excluded/new.ts", content: 'import "../a/private.js";' },
      { path: "src/non-surface.d.ts", content: "export interface Hidden { value: number }" },
      { path: "src/a/new/deep/file.ts", content: source() },
      { path: "src/doomed/last.ts", content: null },
      { path: "src/a/watch.ts", content: 'import "../surface/index.js"; import "./new/deep/file.js"; import "missing-package";' },
    );
    const ordered = tc.draw(gen.arrays(gen.sampledFrom(changes), { minSize: changes.length, maxSize: changes.length, unique: true }));
    const { afterGraph } = await compareCold(root, parent, ordered);
    expect(afterGraph.modules.get("surface")!.surfaceFiles).toContain(join(afterGraph.rootDir, "src/surface/index.ts"));
    expect(afterGraph.program.getRootFileNames()).not.toContain(join(afterGraph.rootDir, "src/excluded/new.ts"));
    expect(afterGraph.program.getRootFileNames()).not.toContain(join(afterGraph.rootDir, "src/non-surface.d.ts"));
    // watch.ts's own bare `import "./new/deep/file.js"` is a side-effect
    // import with no binding at all, and nothing else references this new
    // file - rule 6's own type closure correctly never reaches it, so
    // "became a root" is checked the way the edge walk itself reports it:
    // a real file the scan reached and attributed to module a.
    expect(afterGraph.modules.get("a")!.files).toContain(join(afterGraph.rootDir, "src/a/new/deep/file.ts"));
    expect(afterGraph.modules.get("doomed")!.files).toEqual([]);
    counts.cases++; counts.surface++; counts.excluded += 2; counts.newDirectory++; counts.lastFile++; counts.modified++;
  }), { testCases: 20 });
  expect(counts.cases).toBeGreaterThanOrEqual(20);
  for (const kind of ["surface", "newDirectory", "lastFile", "modified"] as const) expect(counts[kind]).toBe(counts.cases);
  expect(counts.excluded).toBe(counts.cases * 2);
  console.log(JSON.stringify(counts));
}, 60000);

test("source eligibility agrees with the real scan for extensions, exclusions, and declaration surfaces", () => project(async root => {
  const declaredModules = [{ name: "a", glob: "src/a/**", surface: ["index.ts", "public.d.ts"] }];
  configure(root, { declaredModules });
  const paths = ["src/a/normal.ts", "src/a/public.d.ts", "src/a/private.d.ts", "src/a/view.tsx", "src/a/code.js",
    "src/a/README.md", "src/a/dist/file.ts", "node_modules/file.ts", "src/a/node_modules/file.ts",
    "dist/file.ts", "src/excluded/file.ts", "src/.hidden/file.ts", "src/a/.hidden.ts", "src/a/node_modules.ts"];
  for (const path of paths) put(root, path, "export {};");
  const options = { projectRoot: root, declaredModules, exclude: ["*.ts", "src/excluded/**"] };
  const roots = new Set(graphs.prepareGraph(options).rootNames);
  for (const path of paths) expect(graphs.isEligibleSourceFile(join(root, path), root, options.exclude, declaredModules, graphs.DEFAULT_SURFACE))
    .toBe(roots.has(join(root, path)));
  expect(roots.has(join(root, "src/a/public.d.ts"))).toBe(true);
  expect(roots.has(join(root, "src/a/private.d.ts"))).toBe(false);
  const result = await simulate(root, paths.map(path => ({ path, content: "export const changed = 1;" })));
  expect(result.added).toEqual([]);
}));

test("a surface edit resolves a real type leak through the full rule pipeline", () => project(async (root, parent) => {
  put(root, "src/a/private.ts", 'export interface Hidden { value: number }\nexport function make(): Hidden { return { value: 1 }; }');
  put(root, "src/a/index.ts", 'export { make } from "./private.js";');
  const { result } = await compareCold(root, parent, [{ path: "src/a/index.ts", content: 'export { make, type Hidden } from "./private.js";' }]);
  expect(result.resolved.some(v => v.rule === "type-leak")).toBe(true);
}));

test("deleting an imported non-root declaration removes it from the Program", () => project(async (root, parent) => {
  put(root, "src/a/index.ts", 'import type { Hidden } from "./types.js";');
  put(root, "src/a/types.d.ts", "export interface Hidden { value: number }");
  const { afterGraph } = await compareCold(root, parent, [{ path: "src/a/types.d.ts", content: null }]);
  expect(afterGraph.program.getSourceFile(join(afterGraph.rootDir, "src/a/types.d.ts"))).toBeUndefined();
  expect(afterGraph.unresolvedSpecifiers).toContain("./types.js");
}));

test("line shifts preserve violation identity and resolved text uses the shared renderer", () => project(async root => {
  put(root, "src/b/private.ts", "export const value = 1;");
  const content = 'import { value } from "../b/private.js";';
  put(root, "src/a/index.ts", content);
  expect(await simulate(root, [{ path: "src/a/index.ts", content: `\n\n${content}` }]))
    .toEqual({ mode: "scoped", added: [], resolved: [], unchangedCount: 1 });
  const result = await simulate(root, [{ path: "src/a/index.ts", content: "export {};" }]);
  expect(result.added).toEqual([]);
  expect(result.resolved).toHaveLength(1);
  const output = cli(root, JSON.stringify({ changes: [{ path: "src/a/index.ts", content: "export {};" }] }), []);
  expect(output.status).toBe(0);
  expect(output.stdout).toBe(formatSimulateText(result));
  expect(output.stdout).toContain("resolved violations:\n[public-surface-bypass]");
}));


test("duplicate canonical change paths give the exact error", () => project(async root => {
  const path = "src/a/../a/index.ts";
  await expect(simulate(root, [
    { path: "src/a/index.ts", content: "export const value = 3;" },
    { path, content: null },
  ])).rejects.toEqual(new Error(`duplicate change path: ${path}`));
}));

test("identical proposed configs preserve the baseline violation set", async () => {
  await hegel.testAsync(async tc => {
    const value = tc.draw(gen.integers({ minValue: 0, maxValue: 1000 }));
    const excludeConfig = tc.draw(gen.booleans());
    const bypass = tc.draw(gen.booleans());
    await project(async root => {
      configure(root, { exclude: excludeConfig ? ["*.ts"] : [] });
      put(root, "src/b/private.ts", `export const value = ${value};`);
      if (bypass) put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      const baseline = await check(root);
      const before = snapshot(root);
      expect(await simulate(root, [{ path: "archstrict.config.ts", content: config }])).toEqual({
        mode: "scoped", added: [], resolved: [],
        unchangedCount: baseline.violations.filter(v => v.path === join(root, "archstrict.config.ts")).length,
      });
      expect(snapshot(root)).toEqual(before);
    });
  }, { testCases: 20 });
});

function realCheck(root: string): AnyViolation[] {
  const output = spawnSync(process.execPath, [cliPath, "check", "--json"], { cwd: root, encoding: "utf8" });
  expect([0, 1]).toContain(output.status);
  const result = JSON.parse(output.stdout);
  expect(result.error).toBeUndefined();
  expect(Array.isArray(result.violations)).toBe(true);
  return result.violations;
}

test("a proposed module surface matches two real CLI checks on the same root", () => project(async root => {
  configure(root, { exclude: [] });
  put(root, "src/b/private.ts", "export const value = 1;");
  put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
  const configPath = join(root, "archstrict.config.ts");
  const original = readFileSync(configPath, "utf8");
  const proposed = `export default ${JSON.stringify({
    declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**", surface: ["index.ts", "private.ts"] }],
    because: "Publish the value as a supported entry point.",
  })};`;
  const before = realCheck(root);
  expect(before.some(v => v.rule === "public-surface-bypass")).toBe(true);
  expect(before.some(v => v.rule === "uncovered-module" && v.path === configPath)).toBe(true);
  let after: AnyViolation[];
  try {
    writeFileSync(configPath, proposed);
    after = realCheck(root);
  } finally { writeFileSync(configPath, original); }
  const disk = snapshot(root);
  const result = await simulate(root, [{ path: "./archstrict.config.ts", content: proposed }], { wholeProject: true });
  const expected = delta(before, after);
  expect(result.resolved.some(v => v.rule === "public-surface-bypass")).toBe(true);
  const fingerprints = (values: AnyViolation[]) => [...new Set(values.map(fingerprintOf))].sort();
  expect(fingerprints(result.added)).toEqual(fingerprints(expected.added));
  expect(fingerprints(result.resolved)).toEqual(fingerprints(expected.resolved));
  expect(result.unchangedCount).toBe(expected.unchangedCount);
  expect(snapshot(root)).toEqual(disk);
  expect(realCheck(root)).toEqual(before);
}));

test.each([false, true])("a proposed exclude change changes config root eligibility: initially excluded=%s", excluded => project(async root => {
  configure(root, { exclude: excluded ? ["*.ts"] : [] });
  const configPath = join(root, "archstrict.config.ts");
  const original = readFileSync(configPath, "utf8");
  const proposed = `export default ${JSON.stringify({
    declaredModules: ["a", "b"].map(name => ({ name, glob: `src/${name}/**` })),
    exclude: excluded ? [] : ["*.ts"], because: "Choose which files the graph includes.",
  })};`;
  const before = realCheck(root);
  let after: AnyViolation[];
  try {
    writeFileSync(configPath, proposed);
    after = realCheck(root);
  } finally { writeFileSync(configPath, original); }
  const result = await simulate(root, [{ path: "archstrict.config.ts", content: proposed }], { wholeProject: true });
  expect(result).toEqual({ mode: "whole-project", ...delta(before, after) });
  const changed = excluded ? result.added : result.resolved;
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ rule: "uncovered-module", path: configPath });
  expect(excluded ? result.resolved : result.added).toEqual([]);
}));

// A module rename alone (same glob, same directory, same real edge) is the
// same debt this rule already treats a sibling module's own surface change
// as (rules/public-surface.ts's own comment on `specifier`/`target`): the
// bypass's identity is the edge (importer, specifier, resolved file), not
// the display name of the module it reaches into, so a rename that
// touches neither resolves nor adds one - it reads as unchanged.
test("a proposed module rename alone leaves an existing bypass unchanged", () => project(async root => {
  put(root, "src/b/private.ts", "export const value = 1;");
  put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
  const proposed = `export default ${JSON.stringify({
    declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "renamed", glob: "src/b/**" }],
    exclude: ["*.ts"], because: "Give the module its new public name.",
  })};`;
  const result = await simulate(root, [{ path: "archstrict.config.ts", content: proposed }], { wholeProject: true });
  expect(result.added).toEqual([]);
  expect(result.resolved).toEqual([]);
  expect(result.unchangedCount).toBe(1);
}));

test("the project config cannot be deleted by a simulation", () => project(async root => {
  await expect(simulate(root, [{ path: "archstrict.config.ts", content: null }]))
    .rejects.toThrow("cannot delete archstrict.config.ts");
}));

// The bug this covers: a single-file module's glob names a file that
// doesn't exist on disk yet. Before this fix, module classification
// (module-graph.ts's own moduleRelativeDir/buildDeclaredModules) asked
// disk directly, read "not a file", and treated the module as a
// directory - so its surface glob resolved against the wrong base and
// matched nothing, making the module read as entirely private. Every real
// import into the proposed file then misread as a public-surface-bypass,
// even the one import this test itself writes into a file the change set
// creates in the same breath.
test("a change set creating a single-file module's own file classifies it as existing, not as a directory", () => project(async root => {
  put(root, "archstrict.config.ts", `export default ${JSON.stringify({
    declaredModules: [
      { name: "app", glob: "src/app/**" },
      { name: "newmod", glob: "src/newmod.ts", surface: "newmod.ts" },
    ],
    exclude: ["*.ts"], because: "test",
  })};`);
  put(root, "src/app/index.ts", 'import { value } from "../newmod.js";\nexport const x = value;\n');
  const result = await simulate(
    root,
    [{ path: "src/newmod.ts", content: "export const value = 1;\n" }],
    { wholeProject: true },
  );
  expect(result.added.filter(v => v.rule === "public-surface-bypass")).toEqual([]);
  expect(result.resolved.filter(v => v.rule === "public-surface-bypass")).toEqual([]);
}));
