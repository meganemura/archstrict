import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkCycles, checkStaleCycleExceptions } from "../src/rules/cycles.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cycles");

describe("checkCycles", () => {
  test("flags the a -> b -> c -> a cycle once, and leaves standalone d alone", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
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
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });

    expect(checkCycles(graph, { ignoredCycles: [["a", "b"]], configPath: "<test>" })).toHaveLength(0);
    expect(checkCycles(graph, { ignoredCycles: [["b", "a"]], configPath: "<test>" })).toHaveLength(0);
    // A pair naming two modules NOT in the cycle together (d is standalone)
    // doesn't touch it.
    expect(checkCycles(graph, { ignoredCycles: [["a", "d"]], configPath: "<test>" })).toHaveLength(1);
  });

  test("checkStaleCycleExceptions flags a pair that names no real cycle, leaves a real one alone", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });

    const stale = checkStaleCycleExceptions(graph, { ignoredCycles: [["a", "d"]], configPath: "<test>" });
    expect(stale).toHaveLength(1);
    expect(stale[0]!.rule).toBe("stale-cycle-exception");
    expect(stale[0]!.evidence).toContain("['a', 'd']");

    const real = checkStaleCycleExceptions(graph, { ignoredCycles: [["a", "b"]], configPath: "<test>" });
    expect(real).toHaveLength(0);
  });
});
