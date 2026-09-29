import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/module-graph.js";
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
