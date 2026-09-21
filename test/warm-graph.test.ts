// Responsibility: compare every warm refresh with cold graph facts after real filesystem edits.
// Boundary: real compiler and resolver; spies only observe cold-build selection.
import { expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as graphs from "../src/module-graph.js";
import type { ModuleGraph, BuildOptions } from "../src/module-graph.js";
import { createWarmGraph } from "../src/warm-graph.js";

function project(run: (root: string, options: BuildOptions) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-warm-")));
  try {
    for (const name of ["a", "b"]) mkdirSync(join(root, "src", name), { recursive: true });
    writeFileSync(join(root, "src/a/index.ts"), 'import { b } from "../b/index.js"; export const a = b;');
    writeFileSync(join(root, "src/b/index.ts"), 'export const b = 1;');
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"commonjs","moduleResolution":"node"}}');
    writeFileSync(join(root, "archstrict.config.ts"), 'export default {};');
    run(root, { projectRoot: root, declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }], exclude: ["*.ts"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function update(path: string, contents: string) {
  let previous = 0;
  try { previous = statSync(path).mtimeMs; } catch { /* New files have no prior timestamp. */ }
  writeFileSync(path, contents);
  const now = new Date(Math.max(Date.now(), previous + 2000));
  utimesSync(path, now, now);
}
function facts(graph: ModuleGraph) {
  return { modules: [...graph.modules], edges: graph.edges, crossModuleEdges: graph.crossModuleEdges,
    outsideFiles: graph.outsideFiles, unsupportedSyntaxCount: graph.unsupportedSyntaxCount,
    unresolvedSpecifierCount: graph.unresolvedSpecifierCount, unresolvedSpecifiers: graph.unresolvedSpecifiers,
    surface: graph.surface, rootDir: graph.rootDir };
}

test("untouched SourceFiles retain object identity across edits and zero-change refreshes", () => project((root, options) => {
  const warm = createWarmGraph();
  const before = warm.refresh(options);
  const a = join(root, "src/a/index.ts"), b = join(root, "src/b/index.ts");
  update(a, 'import "node:fs";');
  const after = warm.refresh(options);
  expect(after.program).not.toBe(before.program);
  expect(after.program.getSourceFile(b) === before.program.getSourceFile(b)).toBe(true);
  expect(after.program.getSourceFile(a)).not.toBe(before.program.getSourceFile(a));
  expect(warm.refresh(options).program.getSourceFile(b) === after.program.getSourceFile(b)).toBe(true);
  expect(facts(after)).toEqual(facts(graphs.buildModuleGraph(options)));
}));

test("changed tsconfig options take the full cold-build path", () => project((root, options) => {
  const spy = vi.spyOn(graphs, "buildModuleGraph");
  try {
    const warm = createWarmGraph();
    const before = warm.refresh(options);
    warm.refresh(options);
    expect(spy).toHaveBeenCalledTimes(1);
    update(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"strict":true}}');
    const after = warm.refresh(options);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(after.program.getSourceFile(join(root, "src/b/index.ts"))).not.toBe(before.program.getSourceFile(join(root, "src/b/index.ts")));
  } finally { spy.mockRestore(); }
}));

test("changed architecture config takes the full cold-build path", () => project((root, options) => {
  const spy = vi.spyOn(graphs, "buildModuleGraph");
  try {
    const warm = createWarmGraph();
    const before = warm.refresh(options);
    warm.refresh(options);
    expect(spy).toHaveBeenCalledTimes(1);
    update(join(root, "archstrict.config.ts"), 'export default { because: "changed" };');
    const after = warm.refresh(options);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(after.program.getSourceFile(join(root, "src/b/index.ts"))).not.toBe(before.program.getSourceFile(join(root, "src/b/index.ts")));
  } finally { spy.mockRestore(); }
}));

test("checker remains a lazy getter after a warm refresh", () => project((_root, options) => {
  const warm = createWarmGraph();
  warm.refresh(options);
  const graph = warm.refresh(options);
  const spy = vi.spyOn(graph.program, "getTypeChecker");
  expect(spy).not.toHaveBeenCalled();
  expect(typeof Object.getOwnPropertyDescriptor(graph, "checker")?.get).toBe("function");
  expect(graph.checker).toBe(graph.program.getTypeChecker());
  expect(spy).toHaveBeenCalledTimes(2);
}));

const kinds = ["imports", "add-root", "delete-root", "tsconfig", "config", "delete-non-root", "resolve-missing", "shadow"] as const;
type Kind = typeof kinds[number];
// Twenty generated cases, each with up to 16 real Program rebuilds, measured 17–18s under load and exceeded the 15s default.
// Give this test a 60s margin without changing the default for other tests.
test("every edit in generated sequences preserves cold facts and exercises all resolution transitions", () => {
  const counts = Object.fromEntries(kinds.map(kind => [kind, 0])) as Record<Kind, number>;
  let cases = 0, edits = 0;
  hegel.test(tc => project((root, options) => {
    const sequence = [...tc.draw(gen.arrays(gen.sampledFrom(kinds), { minSize: kinds.length, maxSize: kinds.length, unique: true })),
      ...tc.draw(gen.arrays(gen.sampledFrom(kinds), { maxSize: 8 }))];
    const imports = tc.draw(gen.arrays(gen.sampledFrom(['import "node:fs";', 'export { b } from "../b/index.js";',
      'import type { B } from "../b/index.js";', 'void import("../b/index.js");', 'require("../b/index.js");', 'import "missing-package";'])));
    update(join(root, "src/a/index.ts"), imports.join("\n"));
    mkdirSync(join(root, "deps"));
    const watch: string[] = [];
    for (let i = 0; i < sequence.length; i++) {
      writeFileSync(join(root, "deps", `gone${i}.d.ts`), 'export interface T { value: string }');
      mkdirSync(join(root, "deps", `shadow${i}`));
      writeFileSync(join(root, "deps", `shadow${i}`, "index.d.ts"), 'export interface T { value: number }');
      watch.push(`import type { T as G${i} } from "../../deps/gone${i}.js";`,
        `import type { T as P${i} } from "../../deps/pending${i}.js";`, `import type { T as S${i} } from "../../deps/shadow${i}";`);
      writeFileSync(join(root, "src/b", `doomed${i}.ts`), 'import "node:path";');
    }
    writeFileSync(join(root, "src/a/watch.ts"), watch.join("\n"));
    writeFileSync(join(root, "src/loose.ts"), 'export const loose = 1;');
    const warm = createWarmGraph();
    let previous = warm.refresh(options);
    expect(facts(previous)).toEqual(facts(graphs.buildModuleGraph(options)));
    for (const [i, kind] of sequence.entries()) {
      const gone = `../../deps/gone${i}.js`, pending = `../../deps/pending${i}.js`, shadow = `../../deps/shadow${i}`;
      if (kind === "delete-non-root") expect(previous.edges.some(edge => edge.specifier === gone)).toBe(true);
      if (kind === "resolve-missing") expect(previous.unresolvedSpecifiers).toContain(pending);
      if (kind === "shadow") expect(previous.edges.find(edge => edge.specifier === shadow)?.resolvedFile).toBe(join(root, "deps", `shadow${i}`, "index.d.ts"));
      switch (kind) {
        case "imports": update(join(root, "src/a/index.ts"), `${imports.join("\n")}\nimport "node:path";\n// ${i}`); break;
        case "add-root": writeFileSync(join(root, "src/a", `new${i}.ts`), 'import "../b/index.js";'); break;
        case "delete-root": rmSync(join(root, "src/b", `doomed${i}.ts`)); break;
        case "tsconfig": update(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "commonjs", moduleResolution: "node", strict: true, baseUrl: `./base${i}` } })); break;
        case "config": update(join(root, "archstrict.config.ts"), `export default { because: "edit ${i}" };`); break;
        case "delete-non-root": rmSync(join(root, "deps", `gone${i}.d.ts`)); break;
        case "resolve-missing": writeFileSync(join(root, "deps", `pending${i}.d.ts`), 'export interface T { value: boolean }'); break;
        case "shadow": writeFileSync(join(root, "deps", `shadow${i}.d.ts`), 'export interface T { value: boolean }'); break;
      }
      const current = warm.refresh(options);
      expect(facts(current)).toEqual(facts(graphs.buildModuleGraph(options)));
      if (["delete-non-root", "resolve-missing", "shadow"].includes(kind)) {
        const watchPath = join(root, "src/a/watch.ts");
        expect(current.program.getSourceFile(watchPath) === previous.program.getSourceFile(watchPath)).toBe(true);
      }
      if (kind === "delete-non-root") {
        expect(current.edges.some(edge => edge.specifier === gone)).toBe(false);
        expect(current.unresolvedSpecifiers).toContain(gone);
      }
      if (kind === "resolve-missing") {
        expect(current.unresolvedSpecifiers).not.toContain(pending);
        expect(current.edges.find(edge => edge.specifier === pending)?.resolvedFile).toBe(join(root, "deps", `pending${i}.d.ts`));
      }
      if (kind === "shadow") expect(current.edges.find(edge => edge.specifier === shadow)?.resolvedFile).toBe(join(root, "deps", `shadow${i}.d.ts`));
      counts[kind]++; edits++; previous = current;
    }
    cases++;
  }), { testCases: 20 });
  for (const kind of kinds) expect(counts[kind]).toBeGreaterThanOrEqual(cases);
  console.log(JSON.stringify({ cases, sequenceLength: "8..16", edits, exercised: counts }));
}, 60000);
