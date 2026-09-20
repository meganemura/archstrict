// A dedicated fixture, not the prisma-shape/vscode-shape design fixtures:
// those are pure config-shape proofs with no corresponding source tree on
// disk (packages/1-framework/... doesn't exist as real files) - nothing to
// run buildModuleGraph against. This fixture exercises the identical
// three shapes (a domain allow-matrix, a per-domain layer order, a point
// rule) with the same real-world semantics, on files small enough to
// reason about by hand. The prisma-shape/vscode-shape fixtures themselves
// get run for real against actual source trees in the converter and oracle
// tickets, where a real tree exists to run them against.
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkAllowDeny, checkOrder, checkPoint } from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/constraints");

// declaredModules exist only so buildModuleGraph builds a program over the
// whole tree (module BOUNDARIES are irrelevant to the constraint engine -
// it works purely off tags, one module here is enough).
const config: Config = {
  configPath: "<test>",
  modules: "src/*",
  kinds: { flat: "src/*" },
  because: "test config",
  declaredModules: [{ name: "all", glob: "src/**", surface: "index.ts" }],
  classify: [
    { glob: "src/framework/**", tags: ["domain:framework", "layer:core"] },
    { glob: "src/sql/core/**", tags: ["domain:sql", "layer:core"] },
    { glob: "src/sql/runtime/**", tags: ["domain:sql", "layer:runtime"] },
    { glob: "src/targets/**", tags: ["domain:targets", "layer:core"] },
    { glob: "src/forbidden/**", tags: ["domain:framework", "layer:core"] },
  ],
  edges: {
    allowDeny: [
      { source: "domain:framework", targetNamespace: "domain", allow: [], because: "framework is the innermost domain" },
      { source: "domain:sql", targetNamespace: "domain", allow: ["framework"], because: "sql may import only framework" },
      { source: "domain:targets", targetNamespace: "domain", allow: ["framework", "sql"], because: "targets may import framework and sql" },
    ],
    order: [
      {
        tagNamespace: "layer",
        within: "domain",
        sequence: { sql: ["core", "runtime"] },
        direction: "downward-only",
        because: "dependencies flow toward core",
      },
    ],
    point: [{ from: "src/**", to: "src/internal/**", because: "src/internal is not a public surface" }],
  },
};

function graph() {
  return buildModuleGraph({ projectRoot: FIXTURE, declaredModules: config.declaredModules! });
}

describe("checkAllowDeny", () => {
  test("flags domain:framework reaching domain:sql, allows domain:sql reaching domain:framework and domain:targets reaching domain:sql", () => {
    const violations = checkAllowDeny(graph(), config);
    const flaggedFiles = violations.map((v) => v.path.split("/").slice(-2).join("/"));

    expect(flaggedFiles).toEqual(["forbidden/x.ts"]);
    expect(violations[0]!.rule).toBe("tag-boundary");
    expect(violations[0]!.evidence).toContain("domain:sql");
  });
});

describe("checkOrder", () => {
  test("flags layer:core reaching layer:runtime, allows layer:runtime reaching layer:core", () => {
    const violations = checkOrder(graph(), config);
    const flaggedFiles = violations.map((v) => v.path.split("/").slice(-2).join("/"));

    expect(flaggedFiles).toEqual(["core/bad.ts"]);
    expect(violations[0]!.rule).toBe("tag-order");
  });

  test("does not apply across domains: sql reaching framework (both layer:core) is not an order violation", () => {
    const violations = checkOrder(graph(), config);
    expect(violations.some((v) => v.path.endsWith("sql/core/a.ts"))).toBe(false);
  });
});

describe("checkPoint", () => {
  test("flags an edge reaching src/internal/**", () => {
    const violations = checkPoint(graph(), config);
    const flaggedFiles = violations.map((v) => v.path.split("/").slice(-2).join("/"));

    expect(flaggedFiles).toEqual(["core/reaches-internal.ts"]);
    expect(violations[0]!.rule).toBe("point-rule");
  });
});
