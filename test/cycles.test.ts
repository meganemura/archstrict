import { describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/module-graph.js";
import type { Edge, Module, ModuleGraph } from "../src/module-graph.js";
import { makeProjectRelativePosix } from "../src/project-path.js";
import type { Config } from "../src/config.js";
import { createConfigLocator, locateViolation } from "../src/config-pointer.js";
import { checkCycles, checkStaleCycleExceptions } from "../src/rules/cycles.js";
import { fingerprintOf } from "../src/todo-store.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cycles");
const declaredModules = ["a", "b", "c", "d"].map((name) => ({ name, glob: `src/${name}/**` }));

describe("checkCycles", () => {
  test("flags the a -> b -> c -> a cycle once, and leaves standalone d alone", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);

    const [violation] = violations;
    expect(violation!.rule).toBe("cycle");
    // Name-first among {a, b, c}: "a".
    expect(violation!.todoModule).toBe("a");
    expect(violation!.evidence).toBe("a -> b -> c -> a");
    expect(violation!.because.length).toBeGreaterThan(0);
  });

  test("a pair named in ignoredCycles exempts the a -> b -> c -> a cycle, in either order", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

    expect(checkCycles(graph, { ignoredCycles: [["a", "b"]], configPath: "<test>" })).toHaveLength(0);
    expect(checkCycles(graph, { ignoredCycles: [["b", "a"]], configPath: "<test>" })).toHaveLength(0);
    // A pair naming two modules NOT in the cycle together (d is standalone)
    // doesn't touch it.
    expect(checkCycles(graph, { ignoredCycles: [["a", "d"]], configPath: "<test>" })).toHaveLength(1);
  });

  test("checkStaleCycleExceptions flags a pair that names no real cycle, leaves a real one alone", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

    const stale = checkStaleCycleExceptions(graph, { ignoredCycles: [["a", "d"]], configPath: "<test>" });
    expect(stale).toHaveLength(1);
    expect(stale[0]!.rule).toBe("stale-cycle-exception");
    expect(stale[0]!.evidence).toContain("['a', 'd']");

    const real = checkStaleCycleExceptions(graph, { ignoredCycles: [["a", "b"]], configPath: "<test>" });
    expect(real).toHaveLength(0);
  });
});

test("do names every real import in the fixture cycle", () => {
  const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
  const [violation] = checkCycles(graph);
  expect(violation!.do).toBe("break the cycle at src/a/module.ts -> src/b/module.ts (module a -> b), or merge the modules involved - real import chain: src/a/module.ts -> src/b/module.ts, src/b/module.ts -> src/c/module.ts, src/c/module.ts -> src/a/module.ts");
  expect(violation!.path).toBe(join(graph.rootDir, "src/a/module.ts"));
  expect(violation!.line).toBe(1);
});

test("coarse module buckets name the actual importing files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-coarse-cycle-")));
  try {
    mkdirSync(join(root, "src/rules"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
    writeFileSync(join(root, "src/index.ts"), "export const entry = 1;");
    writeFileSync(join(root, "src/config.ts"), "export const config = 1;");
    writeFileSync(join(root, "src/todo-store.ts"), 'import "./rules/type-leak.js";');
    writeFileSync(join(root, "src/rules/index.ts"), "export const rules = 1;");
    writeFileSync(join(root, "src/rules/type-leak.ts"), 'import "../config.js";');
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: [
      { name: "root", glob: "src/*.ts", surface: "*.ts" },
      { name: "rules", glob: "src/rules/**", surface: "*.ts" },
    ] });
    expect(graph.unresolvedSpecifierCount).toBe(0);
    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toBe("root -> rules -> root");
    expect(violations[0]!.do).toBe("root imports rules 1 time(s): src/todo-store.ts -> src/rules/type-leak.ts; rules imports root 1 time(s): src/rules/type-leak.ts -> src/config.ts; either extract the part both sides use into a leaf module that root and rules both import, or pass the dependency in from the side that owns it, so the other side stops importing it; run archstrict simulate on the planned change first");
    expect(violations[0]!.path).toBe(join(root, "src/todo-store.ts"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Repeated side-effect imports (`import "./x.js";`), one per line, are the
// simplest way to get an exact, deliberate edge count between two modules
// without needing distinct real exports for each one.
function repeatedImport(specifier: string, count: number): string {
  return Array.from({ length: count }, () => `import "${specifier}";`).join("\n") + "\n";
}

const lopsidedDeclaredModules = ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**`, surface: "*.ts" }));

function buildLopsidedFixture(root: string, files: Record<string, string>): void {
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

test("a lopsided 2-module cycle (6 edges a -> b, 1 edge b -> a) names the b -> a edge first", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-lopsided-cycle-")));
  try {
    buildLopsidedFixture(root, {
      "src/a/module.ts": repeatedImport("../b/module.js", 6),
      "src/b/module.ts": repeatedImport("../a/module.js", 1),
    });
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: lopsidedDeclaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toBe("a -> b -> a");
    expect(violations[0]!.do).toBe(
      "remove the 1 import(s) from b to a (a imports b 6 times, so b -> a is likely the unintended direction): src/b/module.ts -> src/a/module.ts" +
      "; alternatively, a imports b 6 time(s): src/a/module.ts -> src/b/module.ts; b imports a 1 time(s): src/b/module.ts -> src/a/module.ts; " +
      "either extract the part both sides use into a leaf module that a and b both import, or pass the dependency in from the side that owns it, so the other side stops importing it; run archstrict simulate on the planned change first",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a balanced 2-module cycle (2 edges each way) names both sides and the two moves", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-balanced-cycle-")));
  try {
    buildLopsidedFixture(root, {
      "src/a/module.ts": repeatedImport("../b/module.js", 2),
      "src/b/module.ts": repeatedImport("../a/module.js", 2),
    });
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: lopsidedDeclaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.do).toBe(
      "a imports b 2 time(s): src/a/module.ts -> src/b/module.ts; b imports a 2 time(s): src/b/module.ts -> src/a/module.ts; " +
      "either extract the part both sides use into a leaf module that a and b both import, or pass the dependency in from the side that owns it, so the other side stops importing it; run archstrict simulate on the planned change first",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a 3-module cycle with one lopsided pair inside (b <-> c, not the anchor's own edge) names that pair's minority edge first", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-lopsided-triangle-")));
  try {
    // a -> b (1) and c -> a (1) are each one-directional - only b <-> c has
    // edges both ways (6 and 1), so the lopsided pair here is not the one
    // adjacent to the anchor module "a" in the shortest reported cycle.
    buildLopsidedFixture(root, {
      "src/a/module.ts": repeatedImport("../b/module.js", 1),
      "src/b/module.ts": repeatedImport("../c/module.js", 6),
      "src/c/module.ts": repeatedImport("../b/module.js", 1) + repeatedImport("../a/module.js", 1),
    });
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: lopsidedDeclaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toBe("a -> b -> c -> a");
    expect(violations[0]!.do).toBe(
      "remove the 1 import(s) from c to b (b imports c 6 times, so c -> b is likely the unintended direction): src/c/module.ts -> src/b/module.ts" +
      "; alternatively, break the cycle at src/a/module.ts -> src/b/module.ts (module a -> b), or merge the modules involved - real import chain: src/a/module.ts -> src/b/module.ts, src/b/module.ts -> src/c/module.ts, src/c/module.ts -> src/a/module.ts",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a lopsided pair's minority edges spread across more than one file are listed sorted and comma-joined", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-lopsided-multifile-")));
  try {
    buildLopsidedFixture(root, {
      "src/a/module.ts": repeatedImport("../b/module.js", 6),
      "src/b/module.ts": "export const noop = 1;\n",
      "src/b/x.ts": repeatedImport("../a/module.js", 1),
      "src/b/y.ts": repeatedImport("../a/module.js", 1),
    });
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: lopsidedDeclaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.do).toBe(
      "remove the 2 import(s) from b to a (a imports b 6 times, so b -> a is likely the unintended direction): src/b/x.ts -> src/a/module.ts, src/b/y.ts -> src/a/module.ts" +
      "; alternatively, a imports b 6 time(s): src/a/module.ts -> src/b/module.ts; b imports a 2 time(s): src/b/x.ts -> src/a/module.ts, src/b/y.ts -> src/a/module.ts; " +
      "either extract the part both sides use into a leaf module that a and b both import, or pass the dependency in from the side that owns it, so the other side stops importing it; run archstrict simulate on the planned change first",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a lopsided cycle's fingerprint is unchanged from a balanced-do: cycle with the same evidence", () => {
  // fingerprintOf hashes rule + evidence only (path is excluded for the
  // cycle rule already) - the lopsided and balanced fixtures above produce
  // the same evidence ("a -> b -> a") and so must produce the same
  // fingerprint despite their different do: text.
  const lopsidedRoot = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-lopsided-fp-")));
  const balancedRoot = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-balanced-fp-")));
  try {
    buildLopsidedFixture(lopsidedRoot, {
      "src/a/module.ts": repeatedImport("../b/module.js", 6),
      "src/b/module.ts": repeatedImport("../a/module.js", 1),
    });
    buildLopsidedFixture(balancedRoot, {
      "src/a/module.ts": repeatedImport("../b/module.js", 2),
      "src/b/module.ts": repeatedImport("../a/module.js", 2),
    });
    const lopsidedGraph = buildModuleGraph({ projectRoot: lopsidedRoot, declaredModules: lopsidedDeclaredModules });
    const balancedGraph = buildModuleGraph({ projectRoot: balancedRoot, declaredModules: lopsidedDeclaredModules });
    const [lopsided] = checkCycles(lopsidedGraph);
    const [balanced] = checkCycles(balancedGraph);
    expect(lopsided!.do).not.toBe(balanced!.do);
    expect(fingerprintOf(lopsided!)).toBe(fingerprintOf(balanced!));
    // Pinned from a build of cycles.ts before the lopsided do: existed, on
    // this same fixture: fingerprintOf hashes only rule and evidence, so an
    // unchanged hash here means evidence (and so the fingerprint) really
    // didn't move when the do: text did.
    expect(fingerprintOf(lopsided!)).toBe("ab5fb7328cfa");
  } finally {
    rmSync(lopsidedRoot, { recursive: true, force: true });
    rmSync(balancedRoot, { recursive: true, force: true });
  }
});

const FAKE_ROOT = "/project";

const cycleTemplate = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

function cycleGraph(moduleNames: readonly string[], edges: Edge[]): ModuleGraph {
  return {
    ...cycleTemplate,
    modules: new Map(moduleNames.map((name): [string, Module] => [name, {
      name, dir: `${FAKE_ROOT}/src/${name}`, rootIsFile: false,
      boundaryRoots: [`${FAKE_ROOT}/src/${name}`],
      files: [...new Set(edges.filter(edge => edge.fromModule === name).map(edge => edge.fromFile))],
      surfaceFiles: [], surfaceName: "index.ts", friends: [],
    }])),
    edges,
    crossModuleEdges: edges,
    rootDir: FAKE_ROOT,
    relativePath: makeProjectRelativePosix(FAKE_ROOT),
  };
}

function valueImports(from: string, to: string, count: number, file = `src/${from}/uses-${to}.ts`, firstLine = 1): Edge[] {
  return Array.from({ length: count }, (_, i) => ({
    fromFile: `${FAKE_ROOT}/${file}`,
    fromModule: from,
    fromPosition: { line: firstLine + i, column: 1 },
    specifier: `../${to}/module.js`,
    mode: undefined,
    isTypeOnly: false,
    isDynamic: false,
    resolvedFile: `${FAKE_ROOT}/src/${to}/module.ts`,
    toModule: to,
    externalPackage: undefined,
  }));
}

function singleCycleAdvice(moduleNames: readonly string[], edges: Edge[]): string {
  const violations = checkCycles(cycleGraph(moduleNames, edges));
  expect(violations).toHaveLength(1);
  return violations[0]!.do;
}

function adviceBeforeFileList(doText: string): string {
  return doText.split(": ")[0]!;
}

function lopsidedLead(from: string, to: string, minority: number, majority: number): string {
  return `remove the ${minority} import(s) from ${from} to ${to} (${to} imports ${from} ${majority} times, so ${from} -> ${to} is likely the unintended direction)`;
}

const TWO_MODULE_MOVES = "either extract the part both sides use into a leaf module that a and b both import, or pass the dependency in from the side that owns it, so the other side stops importing it; run archstrict simulate on the planned change first";

describe("checkCycles do: on a fabricated graph", () => {
  test("the pair with the highest majority-to-minority ratio leads, not the first pair or the one with the most imports", () => {

    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b", "c"], [
      ...valueImports("a", "b", 3), ...valueImports("b", "a", 1), ...valueImports("b", "c", 6), ...valueImports("c", "b", 1),
    ]))).toBe(lopsidedLead("c", "b", 1, 6));

    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b", "c"], [
      ...valueImports("a", "b", 6), ...valueImports("b", "a", 2), ...valueImports("b", "c", 4), ...valueImports("c", "b", 1),
    ]))).toBe(lopsidedLead("c", "b", 1, 4));

    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b", "c"], [
      ...valueImports("a", "b", 6), ...valueImports("b", "a", 1), ...valueImports("b", "c", 6), ...valueImports("c", "b", 2),
    ]))).toBe(lopsidedLead("b", "a", 1, 6));
  });

  test("a ratio tie keeps the pair whose module names sort first, whatever order the modules are declared in", () => {
    const tie = [...valueImports("a", "b", 3), ...valueImports("b", "a", 1), ...valueImports("b", "c", 3), ...valueImports("c", "b", 1)];
    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b", "c"], tie))).toBe(lopsidedLead("b", "a", 1, 3));
    expect(adviceBeforeFileList(singleCycleAdvice(["c", "b", "a"], tie))).toBe(lopsidedLead("b", "a", 1, 3));
    const namedTie = [
      ...valueImports("a", "b", 1), ...valueImports("b", "a", 3),
      ...valueImports("a", "undefined", 1), ...valueImports("undefined", "a", 3),
    ];
    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b", "undefined"], namedTie))).toBe(lopsidedLead("a", "b", 1, 3));
    expect(adviceBeforeFileList(singleCycleAdvice(["undefined", "b", "a"], namedTie))).toBe(lopsidedLead("a", "b", 1, 3));
  });

  test("a pair is lopsided only when its minority side has at most three imports and the other side at least three times as many", () => {

    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b"], [...valueImports("a", "b", 1), ...valueImports("b", "a", 3)]))).toBe(lopsidedLead("a", "b", 1, 3));

    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b"], [...valueImports("a", "b", 9), ...valueImports("b", "a", 3)]))).toBe(lopsidedLead("b", "a", 3, 9));
    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b"], [...valueImports("a", "b", 12), ...valueImports("b", "a", 4)]))).toBe("a imports b 12 time(s)");

    expect(singleCycleAdvice(["a", "b", "c"], [...valueImports("a", "b", 3), ...valueImports("b", "c", 1), ...valueImports("c", "a", 1)]))
      .toMatch(/^break the cycle at /);
  });

  test("type-only imports do not change the minority direction or value import counts", () => {
    const edges = [
      ...valueImports("a", "b", 1), ...valueImports("b", "a", 3),
      ...valueImports("a", "b", 3, "src/a/types.ts").map((edge) => ({ ...edge, isTypeOnly: true })),
    ];
    expect(adviceBeforeFileList(singleCycleAdvice(["a", "b"], edges))).toBe(
      "remove the 1 import(s) from a to b (b imports a 3 times, so a -> b is likely the unintended direction)",
    );
  });

  test("a lopsided pair lists its minority imports sorted, whatever order the graph lists them in", () => {
    const edges = [
      ...valueImports("a", "b", 9, "src/a/module.ts"),
      ...valueImports("b", "a", 1, "src/b/z.ts"),
      ...valueImports("b", "a", 1, "src/b/y.ts"),
      ...valueImports("b", "a", 1, "src/b/x.ts"),
    ];
    const minorityImports = "src/b/x.ts -> src/a/module.ts, src/b/y.ts -> src/a/module.ts, src/b/z.ts -> src/a/module.ts";
    expect(singleCycleAdvice(["a", "b"], edges)).toBe(
      `remove the 3 import(s) from b to a (a imports b 9 times, so b -> a is likely the unintended direction): ${minorityImports}` +
      `; alternatively, a imports b 9 time(s): src/a/module.ts -> src/b/module.ts; b imports a 3 time(s): ${minorityImports}; ${TWO_MODULE_MOVES}`,
    );
  });

  test("each side of a two-module cycle names its first three imports in sorted order and counts the rest", () => {

    const edges = [
      ...["z", "y", "x", "w"].flatMap((name) => valueImports("a", "b", 1, `src/a/${name}.ts`)),
      ...["z", "y", "x"].flatMap((name) => valueImports("b", "a", 1, `src/b/${name}.ts`)),
    ];
    expect(singleCycleAdvice(["a", "b"], edges)).toBe(
      "a imports b 4 time(s): src/a/w.ts -> src/b/module.ts, src/a/x.ts -> src/b/module.ts, src/a/y.ts -> src/b/module.ts (and 1 more); " +
      `b imports a 3 time(s): src/b/x.ts -> src/a/module.ts, src/b/y.ts -> src/a/module.ts, src/b/z.ts -> src/a/module.ts; ${TWO_MODULE_MOVES}`,
    );
  });

  test("violations do not depend on the order the graph lists edges or declares modules in", () => {
    const names = ["a", "b", "c", "d"];
    const byEvidence = (violations: ReturnType<typeof checkCycles>) =>
      [...violations].sort((x, y) => (x.evidence < y.evidence ? -1 : x.evidence > y.evidence ? 1 : 0));

    const shuffle = <T>(items: readonly T[], keys: readonly number[]): T[] =>
      items.map((item, i) => ({ item, key: keys[i]! })).sort((x, y) => x.key - y.key).map(({ item }) => item);
    hegel.test((tc) => {
      const fileCount = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const edges: Edge[] = [];
      for (const from of names) {
        for (const to of names) {
          if (from === to) continue;
          const count = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));

          for (let i = 0; i < count; i++) {
            edges.push(...valueImports(from, to, 1, `src/${from}/f${i % fileCount}.ts`, edges.length + 1));
          }
        }
      }
      const edgeKeys = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { minSize: edges.length, maxSize: edges.length }));
      const nameKeys = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { minSize: names.length, maxSize: names.length }));
      const expectedCount = cyclicComponents(names, edges).length;
      assert.equal(checkCycles(cycleGraph(names, edges)).length, expectedCount);
      assert.equal(checkCycles(cycleGraph(shuffle(names, nameKeys), shuffle(edges, edgeKeys))).length, expectedCount);
      assert.deepEqual(
        byEvidence(checkCycles(cycleGraph(shuffle(names, nameKeys), shuffle(edges, edgeKeys)))),
        byEvidence(checkCycles(cycleGraph(names, edges))),
      );
    }, { testCases: 50 });
  });
});

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

function importAt(from: string, to: string, file: string, line: number, column: number): Edge {
  return { ...valueImports(from, to, 1, file)[0]!, fromPosition: { line, column } };
}

describe("checkCycles location on a fabricated graph", () => {
  test("a cycle is reported at the earliest import between its first two modules: the importing file first in path order, then the earliest line, then the earliest column", () => {

    const aToB = [
      importAt("a", "b", "src/a/y.ts", 1, 1),
      importAt("a", "b", "src/a/x.ts", 9, 1),
      importAt("a", "b", "src/a/x.ts", 5, 30),
      importAt("a", "b", "src/a/x.ts", 5, 8),
    ];
    for (const order of permutations(aToB)) {
      const violations = checkCycles(cycleGraph(["a", "b"], [...order, ...valueImports("b", "a", 1)]));
      expect(violations).toHaveLength(1);
      const { path, line, column } = violations[0]!;
      expect({ path, line, column }).toEqual({ path: `${FAKE_ROOT}/src/a/x.ts`, line: 5, column: 8 });
    }
  });

  test("two equally short cycles through the anchor module give the same violation whatever order the graph lists their edges in", () => {

    const edges = [...valueImports("a", "b", 1), ...valueImports("b", "a", 1), ...valueImports("a", "c", 1), ...valueImports("c", "a", 1)];
    const expected = checkCycles(cycleGraph(["a", "b", "c"], edges));
    expect(expected).toHaveLength(1);
    for (const order of permutations(edges)) {
      expect(checkCycles(cycleGraph(["a", "b", "c"], order))).toEqual(expected);
    }
  });
});

function cyclicComponents(names: readonly string[], edges: readonly Edge[]): string[][] {
  const reachable = new Map<string, Set<string>>();
  for (const start of names) {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const from = pending.pop()!;
      for (const edge of edges) {
        if (edge.fromModule !== from || edge.isTypeOnly || edge.toModule === undefined) continue;
        if (!seen.has(edge.toModule)) {
          seen.add(edge.toModule);
          pending.push(edge.toModule);
        }
      }
    }
    reachable.set(start, seen);
  }
  const remaining = new Set(names);
  const components: string[][] = [];
  for (const start of names) {
    if (!remaining.has(start)) continue;
    const members = names.filter(name => reachable.get(start)!.has(name) && reachable.get(name)!.has(start));
    members.forEach(name => remaining.delete(name));
    if (members.length > 1) components.push([...members].sort());
  }
  return components;
}

describe("checkCycles evidence on a fabricated graph", () => {

  test("equal-length cycles have stable evidence in module-name order", () => {

    expect(checkCycles(cycleGraph(["a", "b", "c"], [
      ...valueImports("c", "a", 1), ...valueImports("a", "c", 1), ...valueImports("b", "a", 1), ...valueImports("a", "b", 1),
    ])).map((v) => v.evidence)).toEqual(["a -> b -> a"]);

    expect(checkCycles(cycleGraph(["a", "b", "c", "d"], [
      ...valueImports("d", "a", 1), ...valueImports("c", "a", 1), ...valueImports("b", "d", 1), ...valueImports("b", "c", 1), ...valueImports("a", "b", 1),
    ])).map((v) => v.evidence)).toEqual(["a -> b -> c -> a"]);
  });

  test("each cyclic component has one closed witness of real edges and a selected import in that witness", () => {
    const names = ["a", "b", "c", "d", "e"];
    const orderedPairs = names.flatMap((from) => names.filter((to) => to !== from).map((to) => [from, to] as const));
    hegel.test((tc) => {
      const present = tc.draw(gs.arrays(gs.booleans(), { minSize: orderedPairs.length, maxSize: orderedPairs.length }));
      const pairs = orderedPairs.filter(([from, to], i) => present[i] ||
        (from === "a" && to === "b") || (from === "b" && to === "a") ||
        (from === "c" && to === "d") || (from === "d" && to === "c"));
      const edges = pairs.flatMap(([from, to]) => valueImports(from, to, 1).map(edge => ({ ...edge, isDynamic: from === "a" || from === "c" })));
      const components = cyclicComponents(names, edges);
      const violations = checkCycles(cycleGraph(names, edges));
      assert.equal(violations.length, components.length);
      assert.ok(violations.length >= 1);
      assert.deepEqual(violations.map(v => v.todoModule).sort(), components.map(members => members[0]).sort());
      for (const violation of violations) {
        const witness = violation.evidence.split(" -> ");
        assert.equal(witness[0], witness.at(-1));
        assert.ok(witness.length >= 3);
        const members = witness.slice(0, -1);
        assert.equal(new Set(members).size, members.length);
        const component = components.find(group => group[0] === violation.todoModule);
        assert.ok(component);
        assert.ok(members.every(name => component.includes(name)));
        for (let i = 1; i < witness.length; i++) {
          assert.ok(edges.some(edge => edge.fromModule === witness[i - 1] && edge.toModule === witness[i]));
        }
        const selected = edges.find(edge => edge.fromFile === violation.path &&
          edge.fromPosition.line === violation.line && edge.fromPosition.column === violation.column);
        assert.ok(selected);
        assert.ok(witness.some((from, i) => from === selected.fromModule && witness[i + 1] === selected.toModule));
      }
      const reversed = checkCycles(cycleGraph([...names].reverse(), [...edges].reverse()));
      const byModule = (rows: ReturnType<typeof checkCycles>) => [...rows].sort((a, b) => a.todoModule.localeCompare(b.todoModule));
      assert.deepEqual(byModule(reversed), byModule(violations));
    }, { testCases: 30 });
  });
});

function staleEvidence(moduleNames: readonly string[], edges: Edge[], ignoredCycles: readonly (readonly [string, string])[]): string[] {
  return checkStaleCycleExceptions(cycleGraph(moduleNames, edges), { ignoredCycles, configPath: "<test>" }).map((v) => v.evidence);
}

describe("checkStaleCycleExceptions on a fabricated graph", () => {

  test("an entry is stale when no cycle holds both of its modules: no cycle at all, a cycle among other modules, or a module off every cycle named twice", () => {
    expect(staleEvidence(["a", "b"], valueImports("a", "b", 1), [["a", "b"]]))
      .toEqual(["ignoredCycles entry ['a', 'b'] names no real cycle"]);

    expect(staleEvidence(["a", "b", "c", "d"], [
      ...valueImports("a", "b", 1), ...valueImports("b", "a", 1), ...valueImports("c", "d", 1), ...valueImports("d", "c", 1),
    ], [["a", "b"], ["d", "c"], ["b", "c"]])).toEqual(["ignoredCycles entry ['b', 'c'] names no real cycle"]);

    expect(staleEvidence(["a", "b", "c"], [
      ...valueImports("a", "b", 1), ...valueImports("b", "a", 1), ...valueImports("c", "a", 1),
    ], [["c", "c"], ["a", "a"]])).toEqual(["ignoredCycles entry ['c', 'c'] names no real cycle"]);
  });

  test("an entry is stale exactly when it exempts no cycle from the cycle rule", () => {
    const names = ["a", "b", "c", "d"];
    const orderedPairs = names.flatMap((from) => names.filter((to) => to !== from).map((to) => [from, to] as const));
    hegel.test((tc) => {
      const present = tc.draw(gs.arrays(gs.booleans(), { minSize: orderedPairs.length, maxSize: orderedPairs.length }));
      const graph = cycleGraph(names, orderedPairs.filter((_, i) => present[i]).flatMap(([from, to]) => valueImports(from, to, 1)));
      const entry = [tc.draw(gs.sampledFrom(names)), tc.draw(gs.sampledFrom(names))] as const;
      const exemptsACycle = checkCycles(graph, { ignoredCycles: [entry], configPath: "<test>" }).length
        < checkCycles(graph, { ignoredCycles: [], configPath: "<test>" }).length;
      const stale = checkStaleCycleExceptions(graph, { ignoredCycles: [entry], configPath: "<test>" });
      assert.equal(stale.length, exemptsACycle ? 0 : 1, `entry ['${entry[0]}', '${entry[1]}']`);
    }, { testCases: 30 });
  });

  test("each stale entry, a duplicate included, says to remove itself and points at its own config entry as the value that fired", () => {

    const config: Config = { configPath: "<test>", because: "test", ignoredCycles: [["a", "b"], ["c", "d"], ["c", "d"]] };
    const graph = cycleGraph(["a", "b", "c", "d"], [...valueImports("a", "b", 1), ...valueImports("b", "a", 1)]);
    const stale = checkStaleCycleExceptions(graph, config);
    expect(stale.map((v) => v.do)).toEqual([
      "remove ['c', 'd'] from ignoredCycles in archstrict.config.ts",
      "remove ['c', 'd'] from ignoredCycles in archstrict.config.ts",
    ]);
    for (const violation of stale) expect(violation.because.trim()).not.toBe("");
    const locator = createConfigLocator(config);
    expect(stale.map((v) => locateViolation(v, config, locator).config)).toMatchObject([
      { pointer: "ignoredCycles[1]", value: ["c", "d"], role: "fired" },
      { pointer: "ignoredCycles[2]", value: ["c", "d"], role: "fired" },
    ]);
  });
});
