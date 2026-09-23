// A dedicated fixture, not the prisma-shape/vscode-shape design fixtures:
// those are pure config-shape proofs with no corresponding source tree on
// disk (packages/1-framework/... doesn't exist as real files) - nothing to
// run buildModuleGraph against. The prisma-shape/vscode-shape fixtures
// themselves get run for real against actual source trees in the
// converter and oracle tickets, where a real tree exists to run them
// against.
//
// This file's own dedicated fixture covers the shapes' common case (a
// domain allow-matrix, a per-domain layer order, a glob point rule) on
// files small enough to reason about by hand. The feature surface those
// two named fixtures were built to demonstrate but this fixture's files
// don't reach - a deny list, exceptions, a tag-predicate point rule with
// exclude, an external pkg: target, and the order rule's own config-error
// throw - is covered separately below with a fabricated graph instead
// (checkAllowDeny/checkOrder/checkPoint only ever read `edges` and
// `rootDir`, and classifyFile needs only path strings, not real files).
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkAllowDeny, checkOrder, checkPoint } from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";
import type { Edge, ModuleGraph } from "../src/module-graph.js";

// A fabricated graph, not a real fixture tree: checkAllowDeny/checkOrder/
// checkPoint only ever read `edges` and `rootDir` off a ModuleGraph, and
// classifyFile needs only project-relative path strings, never a real
// file on disk. Used below for shapes the dedicated fixture doesn't reach
// on its own: deny lists, a tag-predicate point rule with `exclude`,
// `exceptions` on allowDeny, an external `pkg:` target, and the order
// rule's own config-error throw.
function fakeGraph(edges: Edge[]): ModuleGraph {
  return { edges, rootDir: "/project" } as ModuleGraph;
}

function edge(overrides: Partial<Edge>): Edge {
  return {
    fromFile: "/project/src/a.ts",
    fromModule: "m",
    fromPosition: { line: 1, column: 1 },
    specifier: "./b.js",
    isTypeOnly: false,
    isDynamic: false,
    resolvedFile: "/project/src/b.ts",
    toModule: "m",
    externalPackage: undefined,
    ...overrides,
  };
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/constraints");

// declaredModules exist only so buildModuleGraph builds a program over the
// whole tree (module BOUNDARIES are irrelevant to the constraint engine -
// it works purely off tags, one module here is enough).
const config: Config = {
  configPath: "<test>",
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

  test("a deny list flags a listed value and lets everything else through", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/shared.ts", tags: ["plane:shared"] },
        { glob: "src/runtime.ts", tags: ["plane:runtime"] },
        { glob: "src/migration.ts", tags: ["plane:migration"] },
      ],
      edges: {
        allowDeny: [
          { source: "plane:shared", targetNamespace: "plane", deny: ["migration", "runtime"], because: "shared must not depend on either concrete plane" },
        ],
      },
    };
    const graph = fakeGraph([
      edge({ resolvedFile: "/project/src/runtime.ts", fromFile: "/project/src/shared.ts" }),
      edge({ resolvedFile: "/project/src/migration.ts", fromFile: "/project/src/shared.ts" }),
    ]);

    const violations = checkAllowDeny(graph, cfg);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.rule === "tag-boundary")).toBe(true);
  });

  test("an exceptions glob pair exempts an otherwise-forbidden edge", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["domain:framework"] },
        { glob: "src/b.ts", tags: ["domain:sql"] },
      ],
      edges: {
        allowDeny: [
          {
            source: "domain:framework",
            targetNamespace: "domain",
            allow: [],
            exceptions: [{ from: "src/a.ts", to: "src/b.ts", because: "a documented one-off exception" }],
            because: "framework may not import other domains",
          },
        ],
      },
    };

    expect(checkAllowDeny(fakeGraph([edge({})]), cfg)).toHaveLength(0);
  });

  test("a target's synthesized pkg: tag composes with allowDeny the same as any internal tag", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classifyByDirectoryName: { tagNamespace: "env", names: ["browser", "node"] },
      edges: {
        allowDeny: [
          { source: "env:browser", targetNamespace: "pkg", allow: [], because: "browser code must not depend on node builtins" },
        ],
      },
    };
    const graph = fakeGraph([
      edge({
        fromFile: "/project/src/browser/thing.ts",
        specifier: "node:fs",
        resolvedFile: "node:fs",
        toModule: undefined,
        externalPackage: "fs",
      }),
    ]);

    const violations = checkAllowDeny(graph, cfg);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toContain("pkg:fs");
  });

  test("a single rule targeting the pkg:node umbrella tag catches every distinct real builtin at once", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classifyByDirectoryName: { tagNamespace: "env", names: ["browser"] },
      edges: {
        allowDeny: [{ source: "env:browser", targetNamespace: "pkg", deny: ["node"], because: "test" }],
      },
    };
    const graph = fakeGraph([
      edge({
        fromFile: "/project/src/browser/a.ts",
        specifier: "node:fs",
        resolvedFile: "node:fs",
        toModule: undefined,
        externalPackage: "fs",
      }),
      edge({
        fromFile: "/project/src/browser/b.ts",
        specifier: "node:path",
        resolvedFile: "node:path",
        toModule: undefined,
        externalPackage: "path",
      }),
    ]);

    const violations = checkAllowDeny(graph, cfg);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.path).sort()).toEqual([
      "/project/src/browser/a.ts",
      "/project/src/browser/b.ts",
    ]);
  });

  test("a real external npm package (not a builtin) never gets the pkg:node umbrella tag", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classifyByDirectoryName: { tagNamespace: "env", names: ["browser"] },
      edges: {
        allowDeny: [{ source: "env:browser", targetNamespace: "pkg", deny: ["node"], because: "test" }],
      },
    };
    const graph = fakeGraph([
      edge({
        fromFile: "/project/src/browser/c.ts",
        specifier: "lodash",
        resolvedFile: "/project/node_modules/lodash/index.js",
        toModule: undefined,
        externalPackage: "lodash",
      }),
    ]);

    expect(checkAllowDeny(graph, cfg)).toHaveLength(0);
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

  test("a tag value absent from its own sequence is a config error, not a silent pass", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["domain:sql", "layer:unlisted"] },
        { glob: "src/b.ts", tags: ["domain:sql", "layer:core"] },
      ],
      edges: {
        order: [
          {
            tagNamespace: "layer",
            within: "domain",
            sequence: { sql: ["core", "runtime"] }, // "unlisted" is not here
            direction: "downward-only",
            because: "dependencies flow toward core",
          },
        ],
      },
    };
    expect(() => checkOrder(fakeGraph([edge({})]), cfg)).toThrow(/does not list 'unlisted'/);
  });

  test("a within-value entirely absent from sequence is out of this rule's scope, not a config error - found by running against Prisma's own real config, whose layerOrder covers only 3 of its 5 real domains", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["domain:targets", "layer:core"] },
        { glob: "src/b.ts", tags: ["domain:targets", "layer:core"] },
      ],
      edges: {
        order: [
          {
            tagNamespace: "layer",
            within: "domain",
            sequence: { sql: ["core", "runtime"] }, // no "targets" entry at all
            direction: "downward-only",
            because: "dependencies flow toward core",
          },
        ],
      },
    };
    expect(checkOrder(fakeGraph([edge({})]), cfg)).toEqual([]);
  });

  test("edgeType: \"value\" excludes a real type-only back-reference from an order rule - typeorm's own *DataSourceOptions pattern", () => {
    // A driver's own options type extending the base options type via
    // `import type` - a real, structural back-reference (found via a
    // config-authoring experiment against typeorm/typeorm) that moves
    // "upward" against a real layering rule but has no runtime effect,
    // the same kind of edge allowDeny/point can already exclude with
    // edgeType: "value" but order never could until now.
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/driver.ts", tags: ["layer:driver"] },
        { glob: "src/orchestration.ts", tags: ["layer:orchestration"] },
      ],
      edges: {
        order: [
          {
            tagNamespace: "layer",
            sequence: { "": ["driver", "orchestration"] },
            direction: "downward-only",
            edgeType: "value",
            because: "a driver may not depend on the orchestration layer",
          },
        ],
      },
    };
    const typeOnlyEdge = edge({
      fromFile: "/project/src/driver.ts",
      resolvedFile: "/project/src/orchestration.ts",
      isTypeOnly: true,
    });

    expect(checkOrder(fakeGraph([typeOnlyEdge]), cfg)).toEqual([]);

    // The same edge, as a real value reference, still violates - proving
    // the filter excludes the type-only case specifically, not silently
    // disabling the rule altogether.
    const valueEdge = edge({ ...typeOnlyEdge, isTypeOnly: false });
    const violations = checkOrder(fakeGraph([valueEdge]), cfg);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("tag-order");
  });
});

describe("checkPoint", () => {
  test.each([
    { from: "src/**", to: "src/**", identifier: "src/** -> src/**" },
    {
      from: { tags: ["kind:app"], exclude: { tags: ["role:adapter"] } },
      to: { tags: ["kind:app"] },
      identifier: '{"tags":["kind:app"],"exclude":{"tags":["role:adapter"]}} -> {"tags":["kind:app"]}',
    },
  ])("do identifies the matching point rule: $identifier", ({ from, to, identifier }) => {
    const cfg: Config = {
      configPath: "<test>",
      declaredModules: [],
      because: "test config",
      classify: [{ glob: "src/**", tags: ["kind:app"] }],
      edges: { point: [
        { from: "other/**", to: "other/**", because: "unrelated rule" },
        { from, to, because: "keep this boundary" },
      ] },
    };
    const violations = checkPoint(fakeGraph([edge({})]), cfg);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.do).toBe(
      `remove this edge, or narrow the point rule '${identifier}' in archstrict.config.ts if it's too broad`,
    );
    expect(violations[0]!.evidence).toBe("'./b.js' matches a forbidden edge");
    expect(violations[0]!.because).toBe("keep this boundary");
  });

  test("flags an edge reaching src/internal/**", () => {
    const violations = checkPoint(graph(), config);
    const flaggedFiles = violations.map((v) => v.path.split("/").slice(-2).join("/"));

    expect(flaggedFiles).toEqual(["core/reaches-internal.ts"]);
    expect(violations[0]!.rule).toBe("point-rule");
  });

  test("a tag-predicate point rule with exclude: drivers reachable only from adapters", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/adapters/**", tags: ["domain:sql", "layer:adapters"] },
        { glob: "src/core/**", tags: ["domain:sql", "layer:core"] },
        { glob: "src/drivers/**", tags: ["domain:sql", "layer:drivers"] },
      ],
      edges: {
        point: [
          {
            from: { tags: ["domain:sql"], exclude: { tags: ["layer:adapters"] } },
            to: { tags: ["domain:sql", "layer:drivers"] },
            because: "drivers can only be imported by adapters",
          },
        ],
      },
    };

    const fromAdapter = edge({ fromFile: "/project/src/adapters/a.ts", resolvedFile: "/project/src/drivers/d.ts" });
    const fromCore = edge({ fromFile: "/project/src/core/c.ts", resolvedFile: "/project/src/drivers/d.ts" });

    expect(checkPoint(fakeGraph([fromAdapter]), cfg)).toHaveLength(0);
    const violations = checkPoint(fakeGraph([fromCore]), cfg);
    expect(violations).toHaveLength(1);
  });

  test("edgeType: \"value\" exempts a type-only edge into the same forbidden target - Prisma's own CLI-control-seam rule", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      edges: {
        point: [
          {
            from: "src/commands/**",
            to: "src/migration/**",
            edgeType: "value",
            because: "CLI command modules must reach migration-tools through src/control-api",
          },
        ],
      },
    };
    const typeOnly = edge({
      fromFile: "/project/src/commands/a.ts",
      resolvedFile: "/project/src/migration/b.ts",
      isTypeOnly: true,
    });
    const value = edge({
      fromFile: "/project/src/commands/a.ts",
      resolvedFile: "/project/src/migration/b.ts",
      isTypeOnly: false,
    });

    expect(checkPoint(fakeGraph([typeOnly]), cfg)).toHaveLength(0);
    expect(checkPoint(fakeGraph([value]), cfg)).toHaveLength(1);
  });
});

describe("edge filters (edgeType, importForm)", () => {
  test("importForm: \"static\" exempts a dynamic import(), \"dynamic\" exempts a static one", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      edges: {
        point: [{ from: "src/**", to: "src/internal/**", importForm: "static", because: "no lazy exception here" }],
      },
    };
    const dynamicEdge = edge({ resolvedFile: "/project/src/internal/x.ts", isDynamic: true });
    const staticEdge = edge({ resolvedFile: "/project/src/internal/x.ts", isDynamic: false });

    expect(checkPoint(fakeGraph([dynamicEdge]), cfg)).toHaveLength(0);
    expect(checkPoint(fakeGraph([staticEdge]), cfg)).toHaveLength(1);
  });

  test("allowDeny's own edgeType filter works the same way as point's", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["domain:framework"] },
        { glob: "src/b.ts", tags: ["domain:sql"] },
      ],
      edges: {
        allowDeny: [{ source: "domain:framework", targetNamespace: "domain", allow: [], edgeType: "value", because: "value imports only" }],
      },
    };
    const typeOnly = edge({ isTypeOnly: true });
    const value = edge({ isTypeOnly: false });

    expect(checkAllowDeny(fakeGraph([typeOnly]), cfg)).toHaveLength(0);
    expect(checkAllowDeny(fakeGraph([value]), cfg)).toHaveLength(1);
  });
});
