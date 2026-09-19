import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkCycles } from "../src/rules/cycles.js";

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
});
