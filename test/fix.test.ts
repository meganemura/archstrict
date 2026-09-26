// Responsibility: exercise source transactions with real compiler graphs and filesystem writes.
// Boundary: disposable projects only; spies observe writes and refreshes without replacing rule evaluation.
import { test, expect, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import ts from "typescript";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
// A real ES module namespace object's own exports are read-only -
// vi.spyOn cannot redefine `ts.createSourceFile` directly. Only this
// file's one test that needs to observe parse calls uses the spy this
// mock installs; every other call here still runs the real
// implementation, unchanged.
vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof ts }>();
  return { ...actual, default: { ...actual.default,
    createSourceFile: vi.fn((...args: Parameters<typeof ts.createSourceFile>) => actual.default.createSourceFile(...args)) } };
});
import { fix, formatFixText, type FixResult } from "../src/verbs/fix.js";
import { check } from "../src/verbs/check.js";
import * as writes from "../src/verbs/agents.js";
import * as graphs from "../src/module-graph.js";
import * as warmGraphs from "../src/warm-graph.js";
import { fingerprintOf, writeTodo } from "../src/todo-store.js";

type Fixture = { root: string; surface: string; put: (path: string, text: string) => void; options: graphs.BuildOptions };
async function project(run: (fixture: Fixture) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-fix-")));
  const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const declaredModules = [{ name: "app", glob: "src/app/**" }, { name: "other", glob: "src/other/**" }];
  const options = { projectRoot: root, declaredModules, exclude: ["*.ts"] };
  try {
    put("tsconfig.json", JSON.stringify({ compilerOptions: { types: [], noLib: true, strict: true, module: "nodenext", target: "esnext" } }));
    put("package.json", '{"type":"module"}');
    put("archstrict.config.ts", `export default ${JSON.stringify({ declaredModules, exclude: ["*.ts"], because: "fixture boundary" })};`);
    put("src/other/index.ts", "export const other = 1;\n");
    put("src/app/internal.ts", 'export interface Hidden { value: string }\nexport function make(): Hidden { return { value: "ok" }; }\n');
    put("src/app/index.ts", 'export { make } from "./internal.js";\n');
    await run({ root, put, options, surface: join(root, "src/app/index.ts") });
  } finally { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
}
function snapshot(root: string): unknown[] {
  return readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString("base64")]);
}
const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
function cli(root: string, ...args: string[]) { return spawnSync(process.execPath, [cliPath, "fix", ...args], { cwd: root, encoding: "utf8" }); }

test("structured leak data preserves the real violation fingerprint", () => project(async ({ root }) => {
  const violation = (await check(root)).violations.find(v => v.rule === "type-leak")!;
  expect(violation.rule).toBe("type-leak");
  if (violation.rule !== "type-leak") throw new Error("expected leak");
  const { leak, ...without } = violation;
  expect(leak).toEqual({ internalType: "Hidden", internalFile: join(root, "src/app/internal.ts"), exportedAs: ["make"] });
  expect(fingerprintOf(without)).toBe(fingerprintOf(violation));
}));

for (const newline of ["\n", "\r\n"]) for (const trailing of [false, true]) {
  test(`exact bytes preserve ${JSON.stringify(newline)} with trailing newline ${trailing}`, () => project(async ({ root, put, surface }) => {
    const original = '// preserve comment' + newline + 'export { make } from "./internal.js";' + (trailing ? newline : "");
    put("src/app/index.ts", original);
    const result = await fix(root);
    expect(result.fixed).toEqual([{ path: surface, lines: ['export type { Hidden } from "./internal.js";'] }]);
    expect(result.unfixable).toEqual([]);
    expect(result.reverted).toEqual([]);
    expect(readFileSync(surface)).toEqual(Buffer.from(original + (trailing ? "" : newline) + 'export type { Hidden } from "./internal.js";' + newline));
    expect((await check(root)).violations.filter(v => v.rule === "type-leak")).toEqual([]);
  }));
}

test("names and specifiers are grouped and sorted before appending", () => project(async ({ root, put, surface }) => {
  put("src/app/z.ts", 'export interface Zebra { value: string }\nexport interface Apple { value: number }\nexport function z(): Zebra { return { value: "x" }; }\nexport function a(): Apple { return { value: 1 }; }');
  put("src/app/a.ts", 'export interface Middle { value: boolean }\nexport function m(): Middle { return { value: true }; }');
  put("src/app/index.ts", 'export { z, a } from "./z.js";\nexport { m } from "./a.js";\n');
  const before = readFileSync(surface, "utf8");
  const lines = ['export type { Middle } from "./a.js";', 'export type { Apple, Zebra } from "./z.js";'];
  expect((await fix(root)).fixed).toEqual([{ path: surface, lines }]);
  expect(readFileSync(surface, "utf8")).toBe(before + lines.join("\n") + "\n");
}));

// One warm core spans every refresh fix() makes across two surfaces' own
// fixes (createWarmGraph called once), and re-parses only what actually
// changed on disk between refreshes - never the unrelated, untouched
// internal.ts, whose own parsed import list warm-graph.ts's own per-file
// cache reuses by mtime (see warm-graph.ts's own header: it holds that
// small, syntactic cache and nothing else - no ts.Program, no parsed AST,
// across refresh calls).
test("multiple surfaces share one warm core and reuse the unchanged file's own parsed imports", () => project(async ({ root, put }) => {
  put("src/other/internal.ts", 'export interface Other { value: number }\nexport function other(): Other { return { value: 1 }; }');
  put("src/other/index.ts", 'export { other } from "./internal.js";\n');
  const original = warmGraphs.createWarmGraph;
  const refreshes: graphs.ModuleGraph[] = [];
  const factory = vi.spyOn(warmGraphs, "createWarmGraph").mockImplementation(() => {
    const warm = original();
    return { refresh(options) { const graph = warm.refresh(options); refreshes.push(graph); return graph; } };
  });
  const internal = join(root, "src/app/internal.ts");
  const parses = vi.mocked(ts.createSourceFile);
  const result = await fix(root);
  expect(result.fixed).toHaveLength(2);
  expect(result.reverted).toEqual([]);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(refreshes).toHaveLength(3);
  // This spy only sees archstrict's own per-file edge walk (the exported
  // `ts.createSourceFile` binding this mock replaces): internal.ts never
  // changes across the whole run, so that walk parses it once, on the
  // first refresh, and reuses the cached record on the other two. Rule 6
  // (type-leak) still forces a fresh ts.Program on every refresh here (no
  // oldProgram is held across calls - warm-graph.ts's own header), and
  // that Program reparses every file, internal.ts included, through
  // TypeScript's own internal parsing path each time - a cost this spy
  // cannot see, because it never calls back through this exported
  // binding.
  expect(parses.mock.calls.filter(call => call[0] === internal)).toHaveLength(1);
}));

test("same-name declarations block the whole file before any write", () => project(async ({ root, put, surface }) => {
  put("src/app/second.ts", 'export interface Hidden { count: number }\nexport function second(): Hidden { return { count: 1 }; }');
  put("src/app/third.ts", 'export interface Unique { ok: boolean }\nexport function third(): Unique { return { ok: true }; }');
  put("src/app/index.ts", 'export { make } from "./internal.js";\nexport { second } from "./second.js";\nexport { third } from "./third.js";\n');
  const before = readFileSync(surface);
  const spy = vi.spyOn(writes, "writeTarget");
  const result = await fix(root);
  expect(result.fixed).toEqual([]);
  expect(result.unfixable).toHaveLength(3);
  expect(result.unfixable.filter(v => v.type === "Hidden")).toHaveLength(2);
  for (const v of result.unfixable) {
    expect(v.reason).toContain("name collision for 'Hidden'");
    expect(v.reason).toContain(join(root, "src/app/internal.ts"));
    expect(v.reason).toContain(join(root, "src/app/second.ts"));
  }
  expect(spy).not.toHaveBeenCalled();
  expect(readFileSync(surface)).toEqual(before);
}));

test("an unresolvable declaration leaves other leaks eligible in the same file", () => project(async ({ root, put, surface }) => {
  put("src/app/odd.mts", 'export interface Odd { n: number }\nexport function odd(): Odd { return { n: 1 }; }');
  put("src/app/index.ts", 'export { make } from "./internal.js";\nexport { odd } from "./odd.mjs";\n');
  const before = readFileSync(surface, "utf8");
  const result = await fix(root);
  expect(result.unfixable).toEqual([{ path: surface, type: "Odd", reason: `no candidate specifier resolves to '${join(root, "src/app/odd.mts")}'` }]);
  expect(result.fixed).toEqual([{ path: surface, lines: ['export type { Hidden } from "./internal.js";'] }]);
  expect(readFileSync(surface, "utf8")).toBe(before + 'export type { Hidden } from "./internal.js";\n');
}));

test("non-exported internal type is unfixable before writing and introduces no semantic diagnostic", () => project(async ({ root, put, surface, options }) => {
  put("src/app/internal.ts", 'interface Hidden { value: string }\nexport function make() { return { value: "ok" } as Hidden; }\n');
  const before = readFileSync(surface);
  expect(graphs.buildModuleGraph(options).program.getSemanticDiagnostics()).toEqual([]);
  const spy = vi.spyOn(writes, "writeTarget");
  const result = await fix(root);
  expect(result.unfixable).toHaveLength(1);
  expect(result.unfixable[0]!.type).toBe("Hidden");
  expect(result.unfixable[0]!.reason).toContain("not exported from its own file");
  expect(result.fixed).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
  expect(readFileSync(surface)).toEqual(before);
  expect(graphs.buildModuleGraph(options).program.getSemanticDiagnostics()).toEqual([]);
}));

test("symlinked surface keeps its link and writes its real target", () => project(async ({ root, surface }) => {
  const target = join(root, "src/app/surface.txt");
  writeFileSync(target, readFileSync(surface)); rmSync(surface); symlinkSync("surface.txt", surface);
  const before = readFileSync(target, "utf8");
  const result = await fix(root);
  expect(result.fixed).toHaveLength(1);
  expect(lstatSync(surface).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(before + 'export type { Hidden } from "./internal.js";\n');
}));

test("dry-run preserves the entire project and reports the real run's statements", () => project(async ({ root }) => {
  const before = snapshot(root);
  const dry = cli(root, "--dry-run", "--json");
  expect(dry.status).toBe(0);
  const plan = JSON.parse(dry.stdout);
  expect(plan.fixed).toEqual([]);
  expect(snapshot(root)).toEqual(before);
  const real = cli(root, "--json");
  expect(real.status).toBe(0);
  expect(JSON.parse(real.stdout).fixed).toEqual(plan.planned);
}));

test("frozen type leak stays untouched", () => project(async ({ root, surface }) => {
  const leak = (await check(root)).violations.find(v => v.rule === "type-leak")!;
  writeTodo(join(root, "src/app"), [{ fingerprint: fingerprintOf(leak), rule: leak.rule, path: leak.path, evidence: leak.evidence }]);
  const before = readFileSync(surface);
  const spy = vi.spyOn(writes, "writeTarget");
  expect((await fix(root)).fixed).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
  expect(readFileSync(surface)).toEqual(before);
}));

test("a real new public-surface violation causes a write then rollback and explicit refresh", () => project(async ({ root, put, surface }) => {
  put("src/other/private.ts", 'export interface Hidden { value: string }');
  put("src/app/internal.ts", 'import type { Hidden } from "../other/private.js";\nexport function make(): Hidden { return { value: "ok" }; }');
  const before = readFileSync(surface);
  const baseline = await check(root);
  expect(baseline.violations.some(v => v.rule === "type-leak")).toBe(true);
  const write = vi.spyOn(writes, "writeTarget");
  const originalFactory = warmGraphs.createWarmGraph;
  const refreshes: graphs.ModuleGraph[] = [];
  vi.spyOn(warmGraphs, "createWarmGraph").mockImplementation(() => {
    const warm = originalFactory();
    return { refresh(options) { const graph = warm.refresh(options); refreshes.push(graph); return graph; } };
  });
  const result = await fix(root);
  expect(result.fixed).toEqual([]);
  expect(result.reverted).toEqual([{ path: surface, reason: "verification reports a new violation" }]);
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[0]![1].toString()).toContain('export type { Hidden } from "../other/private.js";');
  expect(write.mock.calls[1]![1]).toEqual(before);
  expect(refreshes).toHaveLength(3);
  expect(readFileSync(surface)).toEqual(before);
  expect((await check(root)).violations.map(fingerprintOf)).toEqual(baseline.violations.map(fingerprintOf));
}));

test("a second CLI run is idempotent and writes nothing", () => project(async ({ root, surface }) => {
  const first = cli(root, "--json");
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout).fixed).toHaveLength(1);
  const before = readFileSync(surface);
  const inode = lstatSync(surface).ino;
  const second = cli(root, "--json");
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout)).toEqual({ fixed: [], planned: [], unfixable: [], reverted: [] });
  expect(lstatSync(surface).ino).toBe(inode);
  expect(readFileSync(surface)).toEqual(before);
}));

test("scope, text output, invalid arguments, and unfixable exit codes", () => project(async ({ root, put, surface }) => {
  for (const file of ["missing.ts", "src/app/internal.ts"]) {
    const output = cli(root, file, "--json");
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout).fixed).toEqual([]);
  }
  expect(cli(root, "--unknown").status).toBe(1);
  expect(cli(root, "one", "two", "--json").status).toBe(1);
  put("src/app/internal.ts", 'interface Hidden { value: string }\nexport function make(): Hidden { return { value: "x" }; }');
  expect(cli(root, "--json").status).toBe(1);
  expect(cli(root, "--dry-run", "--json").status).toBe(0);
  put("src/app/internal.ts", 'export interface Hidden { value: string }\nexport function make(): Hidden { return { value: "x" }; }');
  const text = cli(root, "src/app/index.ts");
  expect(text.status).toBe(0);
  expect(text.stdout).toContain(`fixed: ${surface}`);
  expect(text.stdout).toContain('export type { Hidden } from "./internal.js";');
}));

test("generated type names and files are fixed with exact compiler-resolved targets", async () => {
  await hegel.testAsync(async tc => project(async ({ root, put, surface, options }) => {
    const names = tc.draw(gen.arrays(gen.fromRegex("[A-Z][a-z]{1,8}"), { unique: true, maxSize: 8 }));
    const files = names.map(() => tc.draw(gen.integers({ minValue: 0, maxValue: 4 })));
    const sources = new Map<number, string[]>();
    const exports: string[] = [];
    for (const [i, name] of names.entries()) {
      const file = files[i]!;
      const lines = sources.get(file) ?? [];
      lines.push(`export interface ${name} { value: string }`, `export function make${i}(): ${name} { return { value: "x" }; }`);
      sources.set(file, lines);
      exports.push(`export { make${i} } from "./part${file}.js";`);
    }
    for (const [file, lines] of sources) put(`src/app/part${file}.ts`, lines.join("\n"));
    put("src/app/index.ts", exports.join("\n"));
    const result = await fix(root);
    expect(result.unfixable).toEqual([]); expect(result.reverted).toEqual([]);
    expect((await check(root)).violations.filter(v => v.rule === "type-leak")).toEqual([]);
    const prepared = graphs.prepareGraph(options);
    const seen = new Set<string>();
    for (const line of result.fixed.flatMap(entry => entry.lines)) {
      const sf = ts.createSourceFile("statement.ts", line, ts.ScriptTarget.Latest, true);
      const statement = sf.statements[0]!;
      if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) throw new Error("expected named re-export");
      expect(statement.isTypeOnly).toBe(true);
      const target = ts.resolveModuleName(statement.moduleSpecifier.text, surface, prepared.compilerOptionsForFile(surface), ts.createCompilerHost(prepared.compilerOptions)).resolvedModule?.resolvedFileName;
      for (const entry of statement.exportClause.elements) {
        seen.add(entry.name.text);
        expect(target).toBe(join(root, `src/app/part${files[names.indexOf(entry.name.text)]}.ts`));
      }
    }
    expect([...seen].sort()).toEqual([...names].sort());
  }), { testCases: 20 });
}, 60000);


test("a failed revert reports both write failures without throwing", () => project(async ({ root, surface }) => {
  const write = vi.spyOn(writes, "writeTarget")
    .mockImplementationOnce(() => { throw new Error("initial write blocked"); })
    .mockImplementationOnce(() => { throw new Error("revert write blocked"); });
  const result = await fix(root);
  expect(write).toHaveBeenCalledTimes(2);
  expect(result.reverted).toHaveLength(1);
  expect(result.reverted[0]!.path).toBe(surface);
  expect(result.reverted[0]!.reason).toContain("verification or write failed: initial write blocked");
  expect(result.reverted[0]!.reason).toContain("revert write blocked");
  expect(result.fixed).toEqual([]);
}));

test("formatFixText prints every category and the exact summary", () => {
  const result: FixResult = {
    fixed: [{ path: "src/a/index.ts", lines: ['export type { A } from "./a.js";'] }],
    planned: [{ path: "src/b/index.ts", lines: ['export type { B } from "./b.js";'] }],
    unfixable: [{ path: "src/c/index.ts", type: "C", reason: "name collision" }],
    reverted: [{ path: "src/d/index.ts", reason: "verification reports a new violation" }],
  };
  expect(formatFixText(result)).toBe([
    "fixed: src/a/index.ts", 'export type { A } from "./a.js";',
    "planned: src/b/index.ts", 'export type { B } from "./b.js";',
    "unfixable: src/c/index.ts (C): name collision",
    "reverted: src/d/index.ts: verification reports a new violation",
    "fixed: 1; planned: 1; unfixable: 1; reverted: 1", "",
  ].join("\n"));
});

test("the built fix CLI prints a real fixed surface in text mode", () => project(async ({ root, surface }) => {
  const output = cli(root);
  expect(output.status).toBe(0);
  expect(output.stdout).toBe(`fixed: ${surface}\nexport type { Hidden } from "./internal.js";\nfixed: 1; planned: 0; unfixable: 0; reverted: 0\n`);
}));
