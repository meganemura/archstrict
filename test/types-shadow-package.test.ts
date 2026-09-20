// A package shipping no bundled type declarations of its own resolves
// through its own @types/ shadow package instead (TypeScript's own
// resolver, not this project's choice) - a real, common case (several
// popular npm packages ship types only via a separate @types/ package).
// tagsForTarget (src/rules/constraints.ts) tags both identities so a rule
// written against either the bare name or the @types/ name matches the
// same real edge - confirmed here against a real fixture reproducing the
// exact resolution TypeScript performs for such a package.
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkAllowDeny } from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/types-shadow-package");

const declaredModules = [{ name: "consumer", glob: "src/consumer/**", surface: "index.ts" }];

function baseConfig(deny: readonly string[]): Config {
  return {
    configPath: "<test>",
    declaredModules,
    classify: [{ glob: "src/consumer/**", tags: ["layer:consumer"] }],
    edges: {
      allowDeny: [{ source: "layer:consumer", targetNamespace: "pkg", deny, because: "test" }],
    },
    because: "test",
  };
}

describe("a package resolving through its own @types/ shadow package", () => {
  test("a rule written against the bare name fires against the real import", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const edge = graph.edges.find((e) => e.specifier === "no-types-pkg");
    expect(edge).toBeDefined();
    // The resolved identity really is the @types/ shadow package, not the
    // bare name - confirming the premise this fix addresses.
    expect(edge!.externalPackage).toBe("@types/no-types-pkg");

    const violations = checkAllowDeny(graph, baseConfig(["no-types-pkg"]));
    expect(violations).toHaveLength(1);
  });

  test("a rule written against the @types/ name also fires against the same real import", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const violations = checkAllowDeny(graph, baseConfig(["@types/no-types-pkg"]));
    expect(violations).toHaveLength(1);
  });

  test("a node: builtin import is completely unaffected - never reaches the @types/ normalization at all", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const builtinEdge = graph.edges.find((e) => e.specifier === "node:fs");
    expect(builtinEdge).toBeDefined();
    expect(builtinEdge!.externalPackage).toBe("fs");

    // A rule targeting "fs" still fires exactly once - unaffected by the
    // @types/ normalization, and not accidentally doubled by it either.
    const violations = checkAllowDeny(graph, baseConfig(["fs"]));
    expect(violations).toHaveLength(1);
  });
});
