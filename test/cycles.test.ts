import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkCycles, checkStaleCycleExceptions } from "../src/rules/cycles.js";

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
    expect(violations[0]!.do).toBe("break the cycle at src/todo-store.ts -> src/rules/type-leak.ts (module root -> rules), or merge the modules involved - real import chain: src/todo-store.ts -> src/rules/type-leak.ts, src/rules/type-leak.ts -> src/config.ts");
    expect(violations[0]!.path).toBe(join(root, "src/todo-store.ts"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
