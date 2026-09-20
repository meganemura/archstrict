import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/package-resolution");

describe("buildModuleGraph (package-specifier resolution)", () => {
  test("a bare package specifier resolves through the workspace's own package.json exports, not left unresolved", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });

    expect(graph.unresolvedSpecifierCount).toBe(0);

    const edge = graph.edges.find((e) => e.specifier === "@internal/a");
    expect(edge).toBeDefined();
    expect(edge!.fromModule).toBe("consumer");
    expect(edge!.toModule).toBeUndefined(); // resolves outside src/* entirely
    expect(edge!.externalPackage).toBe("@internal/a");
    expect(edge!.resolvedFile.endsWith("node_modules/@internal/a/src/index.ts")).toBe(true);
  });

  test("a node builtin (\"node:fs\") is synthesized as its own external edge, not left unresolved", () => {
    // ts.resolveModuleName never returns a real resolvedModule for a
    // builtin - even with `types: ["node"]` set, @types/node's ambient
    // `declare module "node:fs"` is resolved by the checker's own
    // ambient-module lookup, a different mechanism entirely (measured
    // directly). Treating that as "unresolved" would flag nearly every
    // real project's own node:fs/node:path imports as unanalyzable.
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });

    expect(graph.unresolvedSpecifierCount).toBe(0);

    const edge = graph.edges.find((e) => e.specifier === "node:fs");
    expect(edge).toBeDefined();
    expect(edge!.toModule).toBeUndefined();
    expect(edge!.externalPackage).toBe("fs");
  });
});
