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
import { fingerprintOf, writeTodo } from "../src/todo-store.js";

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
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
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
function facts(graph: graphs.ModuleGraph, root: string) {
  return normalize({
    modules: [...graph.modules].map(([name, module]) => [name, { ...module, files: sorted(module.files), surfaceFiles: sorted(module.surfaceFiles) }]),
    edges: sorted(graph.edges), crossModuleEdges: sorted(graph.crossModuleEdges), outsideFiles: sorted(graph.outsideFiles),
    unresolvedSpecifierCount: graph.unresolvedSpecifierCount, unresolvedSpecifiers: sorted(graph.unresolvedSpecifiers),
    unsupportedSyntaxCount: graph.unsupportedSyntaxCount, surface: graph.surface,
    roots: sorted([...graph.program.getRootFileNames()]),
    sources: sorted(graph.program.getSourceFiles().map(source => ({ file: source.fileName, text: source.text }))),
  }, root);
}
async function cold(root: string) {
  const config = await loadConfig(join(root, "archstrict.config.ts"));
  const graph = graphs.buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules, exclude: config.exclude });
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
  const spy = vi.spyOn(graphs, "buildPreparedGraph");
  const result = await simulate(root, changes);
  expect(spy).toHaveBeenCalledTimes(2);
  const baseline = spy.mock.results[0]!.value as graphs.ModuleGraph;
  const simulated = spy.mock.results[1]!.value as graphs.ModuleGraph;
  expect(spy.mock.calls[1]![1]!.oldProgram).toBe(baseline.program);
  expect(facts(baseline, root)).toEqual(facts(before.graph, root));
  spy.mockRestore();
  expect(snapshot(root)).toEqual(diskBefore);
  const copy = join(parent, "copy");
  cpSync(root, copy, { recursive: true });
  for (const change of changes) {
    if (change.content === null) rmSync(join(copy, change.path), { force: true });
    else put(copy, change.path, change.content);
  }
  const after = await cold(copy);
  expect(facts(simulated, root)).toEqual(facts(after.graph, copy));
  const config = await loadConfig(join(root, "archstrict.config.ts"));
  expect(sorted(normalize(applyTodo(simulated, config, runRules(simulated, config)).violations, root)))
    .toEqual(sorted(normalize(after.result.violations, copy)));
  expect({ ...normalize(result, root), added: sorted(normalize(result.added, root)), resolved: sorted(normalize(result.resolved, root)) })
    .toEqual(delta(normalize(before.result.violations, root), normalize(after.result.violations, copy)));
  return { result, simulated, after: after.result };
}

test("two edits together introduce a new cycle that neither edit creates alone", () => project(async (root, parent) => {
  const changes = [{ path: "src/a/index.ts", content: 'import "../b/index.js"; export const value = 1;' },
    { path: "src/b/index.ts", content: 'import "../a/index.js"; export const value = 2;' }];
  for (const change of changes) expect((await simulate(root, [change])).added.some(v => v.rule === "cycle")).toBe(false);
  const { result } = await compareCold(root, parent, changes);
  expect(result.added.some(v => v.rule === "cycle")).toBe(true);
}));

test("removing the last deprecated edge resolves its excess and reports its now-empty declaration", () => project(async (root, parent) => {
  configure(root, { deprecated: [{ from: "a", to: "b", count: 0, because: "Remove this dependency." }] });
  put(root, "src/a/index.ts", 'import "../b/index.js";');
  const { result } = await compareCold(root, parent, [{ path: "src/a/index.ts", content: "export {};" }]);
  expect(result.resolved.some(v => v.rule === "deprecated-edge-increased")).toBe(true);
  expect(result.added.some(v => v.rule === "empty-rule-set" && v.evidence.includes("deprecated edge 'a -> b'"))).toBe(true);
}));

test("deleting a target removes the real edge and its public-surface violation", () => project(async (root, parent) => {
  put(root, "src/b/private.ts", "export const value = 1;");
  put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
  const { result, simulated } = await compareCold(root, parent, [{ path: "src/b/private.ts", content: null }]);
  expect(result.resolved.some(v => v.rule === "public-surface-bypass")).toBe(true);
  expect(simulated.edges).toEqual([]);
  expect(simulated.unresolvedSpecifiers).toContain("../b/private.js");
}));

test("creation in a new directory becomes a root and reports its new violation", () => project(async (root, parent) => {
  const { result, simulated } = await compareCold(root, parent, [{ path: "src/new/deep/file.ts", content: "export {};" }]);
  expect(simulated.program.getRootFileNames()).toContain(join(root, "src/new/deep/file.ts"));
  expect(result.added.some(v => v.rule === "uncovered-module")).toBe(true);
  expect(existsSync(join(root, "src/new"))).toBe(false);
}));

test("imported non-root declarations use overlay text without becoming roots", () => project(async (root, parent) => {
  put(root, "src/a/index.ts", 'import type { Hidden } from "./types.js"; export const value: Hidden = { value: 1 };');
  put(root, "src/a/types.d.ts", "export interface Hidden { value: number }");
  const content = "export interface Hidden { value: number; optional?: string }";
  const { simulated } = await compareCold(root, parent, [{ path: "src/a/types.d.ts", content }]);
  expect(simulated.program.getRootFileNames()).not.toContain(join(root, "src/a/types.d.ts"));
  expect(simulated.program.getSourceFile(join(root, "src/a/types.d.ts"))!.text).toBe(content);
}));

test("simulation preserves disk bytes, timestamps, todo, and a subsequent real check", () => project(async root => {
  put(root, "src/b/private.ts", "export const value = 1;");
  put(root, "src/a/index.ts", 'import { value } from "../b/private.js";');
  const violation = (await check(root)).violations.find(v => v.rule === "public-surface-bypass")!;
  expect(violation.rule).toBe("public-surface-bypass");
  if (violation.rule !== "public-surface-bypass") throw new Error("expected surface violation");
  writeTodo(join(root, "src", violation.todoModule), [{ fingerprint: fingerprintOf(violation), rule: violation.rule, path: violation.path, evidence: violation.evidence }]);
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
  expect(Object.keys(JSON.parse(json.stdout)).sort()).toEqual(["added", "resolved", "unchangedCount"]);
  const text = cli(root, JSON.stringify({ changes }), []);
  expect(text.status).toBe(1);
  expect(text.stdout).toBe(formatSimulateText(result));
  expect(text.stdout).toContain("[uncovered-module]");
  expect(text.stdout).toContain("because:");
  expect(text.stdout).toContain("next:");
  const clean = cli(root, '{"changes":[]}');
  expect(clean.status).toBe(0);
  expect(JSON.parse(clean.stdout)).toEqual({ added: [], resolved: [], unchangedCount: 0 });
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
    const { simulated } = await compareCold(root, parent, ordered);
    expect(simulated.modules.get("surface")!.surfaceFiles).toContain(join(root, "src/surface/index.ts"));
    expect(simulated.program.getRootFileNames()).not.toContain(join(root, "src/excluded/new.ts"));
    expect(simulated.program.getRootFileNames()).not.toContain(join(root, "src/non-surface.d.ts"));
    expect(simulated.program.getRootFileNames()).toContain(join(root, "src/a/new/deep/file.ts"));
    expect(simulated.modules.get("doomed")!.files).toEqual([]);
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
  const { simulated } = await compareCold(root, parent, [{ path: "src/a/types.d.ts", content: null }]);
  expect(simulated.program.getSourceFile(join(root, "src/a/types.d.ts"))).toBeUndefined();
  expect(simulated.unresolvedSpecifiers).toContain("./types.js");
}));

test("line shifts preserve violation identity and resolved text uses the shared renderer", () => project(async root => {
  put(root, "src/b/private.ts", "export const value = 1;");
  const content = 'import { value } from "../b/private.js";';
  put(root, "src/a/index.ts", content);
  expect(await simulate(root, [{ path: "src/a/index.ts", content: `\n\n${content}` }]))
    .toEqual({ added: [], resolved: [], unchangedCount: 1 });
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
