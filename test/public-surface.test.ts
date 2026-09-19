import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");

describe("checkPublicSurfaceBypass", () => {
  test("flags a bypass of a's public.ts, and every import into b (no public.ts)", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });

    // Sanity: module resolution actually worked (a nodenext moduleResolution
    // change that broke .ts-extension resolution would otherwise show up as
    // "0 edges, 0 violations, green" instead of a loud failure.
    expect(graph.unresolvedSpecifierCount).toBe(0);
    expect(graph.crossModuleEdges.length).toBe(3); // widget, secret, gadget

    const violations = checkPublicSurfaceBypass(graph);
    expect(violations).toHaveLength(2);

    const bySpecifier = new Map(violations.map((v) => [v.evidence, v]));
    const secretViolation = [...bySpecifier.values()].find((v) =>
      v.evidence.includes("'../a/internal.ts'"),
    );
    expect(secretViolation).toBeDefined();
    expect(secretViolation?.todoModule).toBe("a");
    expect(secretViolation?.next).toContain("a/public.ts");

    const gadgetViolation = [...bySpecifier.values()].find((v) =>
      v.evidence.includes("'../b/module.ts'"),
    );
    expect(gadgetViolation).toBeDefined();
    expect(gadgetViolation?.todoModule).toBe("b");
    expect(gadgetViolation?.next).toContain("add a public.ts");

    // The import that reaches a's public.ts itself is not a violation.
    expect(
      violations.some((v) => v.evidence.includes("'../a/public.ts'")),
    ).toBe(false);
  });

  test("modules missing entirely from the graph are counted, not silently absent", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    expect(graph.outsideFiles).toEqual([]);
    expect(graph.unsupportedSyntaxCount).toBe(0);
    expect([...graph.modules.keys()].sort()).toEqual(["a", "b", "c"]);
  });
});
