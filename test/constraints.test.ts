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
// files small enough to reason about by hand.
// The fixture does not reach a deny list, exceptions, a tag-predicate
// point rule with exclude, an external target, the edgeType/importForm
// filters, or the order config error. A fabricated graph covers those
// shapes below. The fixture has untagged and cross-scope edges, but no
// fixture test observes whether an order rule judges or counts them; a
// fabricated graph checks that below. The checks read `edges` and the
// project-relative converter. Classification reads path strings, not
// real files. Properties over generated rules and edges belong to
// test/constraints.property.test.ts.
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import {
  checkAllowDeny,
  checkEdgesCoverage,
  checkExhaustiveAllow,
  checkOrder,
  checkPoint,
  type ConstraintViolation,
  type FromToPredicate,
} from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";
import { createConfigLocator, locateViolation } from "../src/config-pointer.js";
import type { Edge, ModuleGraph } from "../src/module-graph.js";
import { makeProjectRelativePosix } from "../src/project-path.js";
import { ReportError } from "../src/report-error.js";

// A fabricated graph needs no fixture tree. These checks read `edges` and
// the relative-path converter. Classification reads project-relative paths.

function fakeGraph(edges: Edge[]): ModuleGraph {
  return { edges, rootDir: "/project", relativePath: makeProjectRelativePosix("/project") } as ModuleGraph;
}

function edge(overrides: Partial<Edge>): Edge {
  return {
    fromFile: "/project/src/a.ts",
    fromModule: "m",
    fromPosition: { line: 1, column: 1 },
    specifier: "./b.js",
    mode: undefined,
    isTypeOnly: false,
    isDynamic: false,
    resolvedFile: "/project/src/b.ts",
    toModule: "m",
    externalPackage: undefined,
    ...overrides,
  };
}

function externalEdge(file: string, specifier: string, resolvedFile: string, externalPackage: string): Edge {
  return edge({ fromFile: `/project/src/browser/${file}`, specifier, resolvedFile, toModule: undefined, externalPackage });
}

// A report names the config entry that fired, so an agent can open the
// exact rule to edit. The configPath names no real file, so only each
// pointer's path and resolved value say anything about the config.
function pointersOf(violation: ConstraintViolation, cfg: Config) {
  const located = locateViolation(violation, cfg, createConfigLocator(cfg));
  const pointers = Array.isArray(located.config) ? located.config : [located.config];
  return pointers.map(({ pointer, role, value }) => ({ pointer, role, value }));
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

  test("an exception never exempts an edge into an external package, even with a to glob that matches every path", () => {
    // An exception is a glob pair over project-relative paths. An external
    // target has no such path, so no `to` glob can name it.
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classifyByDirectoryName: { tagNamespace: "env", names: ["browser"] },
      edges: {
        allowDeny: [{
          source: "env:browser",
          targetNamespace: "pkg",
          deny: ["lodash"],
          // The from glob matches the edge, so only the to side decides.
          exceptions: [{ from: "src/browser/**", to: "**", because: "a broad exception" }],
          because: "browser code avoids lodash",
        }],
      },
    };
    const graph = fakeGraph([externalEdge("a.ts", "lodash", "/project/node_modules/lodash/index.js", "lodash")]);

    expect(checkAllowDeny(graph, cfg)).toHaveLength(1);
  });

  test("a deny rule naming a scoped package fires on an edge resolved through @types/scope__name", () => {
    // DefinitelyTyped spells the scoped package "@babel/core" as
    // "@types/babel__core". A rule author writes the package's own name, not
    // that spelling.
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classifyByDirectoryName: { tagNamespace: "env", names: ["browser"] },
      edges: {
        allowDeny: [{ source: "env:browser", targetNamespace: "pkg", deny: ["@babel/core"], because: "browser code avoids the compiler" }],
      },
    };
    const graph = fakeGraph([
      externalEdge("a.ts", "@babel/core", "/project/node_modules/@types/babel__core/index.d.ts", "@types/babel__core"),
    ]);

    expect(checkAllowDeny(graph, cfg)).toHaveLength(1);
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

  describe("config pointers", () => {
    test("an allow-list violation points at the allow list of the rule that fired, even when an earlier rule shares its source and reason", () => {
      // A lookup that matches a report back to its entry by source and reason
      // finds the first of two entries that share both. Only the index of the
      // rule that fired tells them apart.
      const cfg: Config = {
        configPath: "<test>",
        because: "test config",
        classify: [
          { glob: "src/a.ts", tags: ["domain:framework"] },
          { glob: "src/b.ts", tags: ["domain:sql", "layer:runtime"] },
        ],
        edges: {
          allowDeny: [
            { source: "domain:framework", targetNamespace: "domain", allow: ["sql"], because: "framework stays innermost" },
            { source: "domain:framework", targetNamespace: "layer", allow: ["core"], because: "framework stays innermost" },
          ],
        },
      };

      const violations = checkAllowDeny(fakeGraph([edge({})]), cfg);
      expect(violations).toHaveLength(1);
      expect(pointersOf(violations[0]!, cfg)).toEqual([{ pointer: "edges.allowDeny[1].allow", role: "fired", value: ["core"] }]);
    });

    test("a deny-list violation points at the denied value that fired, and at the rule's allow list as the place to edit", () => {
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
        edge({ fromFile: "/project/src/shared.ts", resolvedFile: "/project/src/migration.ts" }),
        edge({ fromFile: "/project/src/shared.ts", fromPosition: { line: 2, column: 1 }, resolvedFile: "/project/src/runtime.ts" }),
      ]);

      const pointers = checkAllowDeny(graph, cfg).map((violation) => pointersOf(violation, cfg));
      expect(pointers.map((located) => located.map(({ pointer, role }) => ({ pointer, role })))).toEqual([
        [{ pointer: "edges.allowDeny[0].deny[0]", role: "fired" }, { pointer: "edges.allowDeny[0].allow", role: "edit-here" }],
        [{ pointer: "edges.allowDeny[0].deny[1]", role: "fired" }, { pointer: "edges.allowDeny[0].allow", role: "edit-here" }],
      ]);

      expect(pointers.map((located) => located[0]!.value)).toEqual(["migration", "runtime"]);
    });
  });
});

// Each allowDeny entry is judged on its own, blind to every other entry. An
// entry with a deny list and no allow list is never exhaustive, but it must
// not hide the exhaustive allow list of another entry in the same config.
describe("checkExhaustiveAllow", () => {
  test("an allow list that admits every real target value is reported even when another entry has only a deny list", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["domain:framework"] },
        { glob: "src/b.ts", tags: ["domain:sql"] },
      ],
      edges: {
        allowDeny: [
          { source: "domain:framework", targetNamespace: "domain", allow: ["sql"], because: "framework may import only sql" },
          { source: "domain:sql", targetNamespace: "domain", deny: ["framework"], because: "sql must not import framework" },
        ],
      },
    };

    expect(checkExhaustiveAllow(fakeGraph([edge({})]), cfg).map((finding) => finding.identifier)).toEqual([
      "domain:framework -> domain",
    ]);
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

  // Either end of an edge can carry the value that the author forgot to
  // list. A config error carries a next command, as a violation does, and
  // that command must name the value to add.
  test.each([
    { end: "source", sourceLayer: "unlisted", targetLayer: "core" },
    { end: "target", sourceLayer: "core", targetLayer: "unlisted" },
  ])("a tag value absent from its own sequence is a config error, not a silent pass, at the $end end", ({ sourceLayer, targetLayer }) => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["domain:sql", `layer:${sourceLayer}`] },
        { glob: "src/b.ts", tags: ["domain:sql", `layer:${targetLayer}`] },
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
    let thrown: unknown;
    try {
      checkOrder(fakeGraph([edge({})]), cfg);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReportError);
    expect((thrown as ReportError).message).toMatch(/does not list 'unlisted'/);
    expect((thrown as ReportError).do).toContain("'unlisted'");
  });

  // A rule scoped to a namespace says nothing about an edge whose end carries
  // no value in that namespace, and an edge between two `within` scopes lies
  // outside every sequence the rule declares. The rule must neither judge
  // nor count such an edge: a count that includes it would hide a rule that
  // judges nothing from the empty-rule-set check. The combinations are few,
  // so the tests enumerate all of them instead of drawing samples.
  describe("which edges an order rule judges", () => {
    const SEQUENCE = ["core", "runtime"];

    // A thrown error is recorded as a verdict too, so that a combination the
    // rule should skip, but crashes on, shows up beside the others.
    function verdict(cfg: Config): string {
      const graph = fakeGraph([edge({})]);
      try {
        const evaluated = checkEdgesCoverage(graph, cfg).find((c) => c.kind === "order")?.evaluated;
        return `${checkOrder(graph, cfg).length} violation(s), evaluated ${evaluated}`;
      } catch (error) {
        return `threw ${String(error)}`;
      }
    }

    test("an order rule judges an edge only when both ends carry a value in its namespace, and flags it only when the target sits later in the sequence", () => {
      const wrong: string[] = [];
      for (const sourceLayer of [undefined, ...SEQUENCE]) {
        for (const targetLayer of [undefined, ...SEQUENCE]) {
          const cfg: Config = {
            configPath: "<test>",
            because: "test config",
            classify: [
              ...(sourceLayer === undefined ? [] : [{ glob: "src/a.ts", tags: [`layer:${sourceLayer}`] }]),
              ...(targetLayer === undefined ? [] : [{ glob: "src/b.ts", tags: [`layer:${targetLayer}`] }]),
            ],
            edges: {
              order: [{ tagNamespace: "layer", sequence: { "": SEQUENCE }, direction: "downward-only", because: "dependencies flow toward core" }],
            },
          };
          const judged = sourceLayer !== undefined && targetLayer !== undefined;
          const flagged = judged && SEQUENCE.indexOf(targetLayer) > SEQUENCE.indexOf(sourceLayer);
          const expected = `${flagged ? 1 : 0} violation(s), evaluated ${judged ? 1 : 0}`;
          const actual = verdict(cfg);
          if (actual !== expected) wrong.push(`source=${sourceLayer ?? "untagged"} target=${targetLayer ?? "untagged"}: expected ${expected}, got ${actual}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    test("an order rule scoped within a namespace judges an edge only when both ends carry the same value in that namespace", () => {
      const DOMAIN_VALUES = ["sql", "framework"];
      const wrong: string[] = [];
      for (const sourceDomain of [undefined, ...DOMAIN_VALUES]) {
        for (const targetDomain of [undefined, ...DOMAIN_VALUES]) {

          const cfg: Config = {
            configPath: "<test>",
            because: "test config",
            classify: [
              { glob: "src/a.ts", tags: ["layer:core", ...(sourceDomain === undefined ? [] : [`domain:${sourceDomain}`])] },
              { glob: "src/b.ts", tags: ["layer:runtime", ...(targetDomain === undefined ? [] : [`domain:${targetDomain}`])] },
            ],
            edges: {
              order: [{
                tagNamespace: "layer",
                within: "domain",
                sequence: { sql: SEQUENCE, framework: SEQUENCE },
                direction: "downward-only",
                because: "dependencies flow toward core",
              }],
            },
          };
          const judged = sourceDomain !== undefined && sourceDomain === targetDomain ? 1 : 0;
          const expected = `${judged} violation(s), evaluated ${judged}`;
          const actual = verdict(cfg);
          if (actual !== expected) wrong.push(`source=${sourceDomain ?? "no domain"} target=${targetDomain ?? "no domain"}: expected ${expected}, got ${actual}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  });

  // rules.md documents both texts. The do sends the reader to the sequence
  // in archstrict.config.ts, which lists each value without its namespace.
  test("an order violation's evidence names both tags and the whole sequence, and its do names the source's value as the sequence lists it", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a.ts", tags: ["layer:service"] },
        { glob: "src/b.ts", tags: ["layer:runtime"] },
      ],
      edges: {
        order: [{
          tagNamespace: "layer",
          sequence: { "": ["core", "service", "runtime"] },
          direction: "downward-only",
          because: "dependencies flow toward core",
        }],
      },
    };

    expect(checkOrder(fakeGraph([edge({ fromPosition: { line: 3, column: 5 } })]), cfg)).toEqual([{
      rule: "tag-order",
      path: "/project/src/a.ts",
      line: 3,
      column: 5,
      evidence: "'./b.js' reaches 'layer:runtime' from 'layer:service' (layer sequence: core -> service -> runtime)",
      because: "dependencies flow toward core",
      do: "move this edge to depend only on 'layer' values at or before 'service' in archstrict.config.ts's sequence, or restructure the code so it does",
      todoModule: "m",
    }]);
  });

  // Two rules over one namespace with one reason. The first is scoped within
  // `domain`, and no file here carries a domain tag, so only the second rule
  // judges an edge.
  const TWO_RULES_OVER_ONE_NAMESPACE: Config = {
    configPath: "<test>",
    because: "test config",
    classify: [
      { glob: "src/a.ts", tags: ["layer:core"] },
      { glob: "src/b.ts", tags: ["layer:runtime"] },
    ],
    edges: {
      order: [
        { tagNamespace: "layer", within: "domain", sequence: { sql: ["core", "runtime"] }, direction: "downward-only", because: "dependencies flow toward core" },
        { tagNamespace: "layer", sequence: { "": ["core", "runtime"] }, direction: "downward-only", because: "dependencies flow toward core" },
      ],
    },
  };

  test("an order violation points at the sequence of the rule that fired, even when an earlier rule shares its namespace and reason", () => {
    // A lookup that matches a report back to its entry by namespace and
    // reason finds the first of the two entries. Only the index of the rule
    // that fired tells them apart.
    const cfg = TWO_RULES_OVER_ONE_NAMESPACE;
    const violations = checkOrder(fakeGraph([edge({})]), cfg);

    expect(violations).toHaveLength(1);
    expect(pointersOf(violations[0]!, cfg)).toEqual([
      { pointer: "edges.order[1].sequence", role: "fired", value: { "": ["core", "runtime"] } },
    ]);
  });

  // check --json reports these entries as `edgeRuleCoverage`. The name is how
  // a reader tells two order rules over one namespace apart, and an
  // empty-rule-set report names the rule by it in its evidence. The count
  // includes edges the rule allows, not only the edges it flags.
  test("edge rule coverage names each order rule by its namespace and its within namespace, and counts every edge it judged", () => {
    const graph = fakeGraph([
      edge({}),
      edge({ fromFile: "/project/src/b.ts", specifier: "./a.js", resolvedFile: "/project/src/a.ts" }),
    ]);

    expect(checkEdgesCoverage(graph, TWO_RULES_OVER_ONE_NAMESPACE)).toEqual([
      { kind: "order", identifier: "layer within domain", evaluated: 0 },
      { kind: "order", identifier: "layer", evaluated: 2 },
    ]);
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

  // Two tags are enough to tell "every listed tag" from "any listed tag": the
  // two differ only on a file that carries one of two listed tags. The
  // combinations are few, so the tests enumerate all of them instead of
  // drawing samples.
  describe("tag predicates", () => {
    const TAG_SETS: readonly (readonly string[])[] = [[], ["kind:app"], ["role:adapter"], ["kind:app", "role:adapter"]];
    const PREDICATE_TAGS = TAG_SETS.filter((tags) => tags.length > 0);
    const carriesEvery = (file: readonly string[], listed: readonly string[]) => listed.every((tag) => file.includes(tag));

    function pointConfig(fileTags: { glob: string; tags: readonly string[] }, rule: { from: FromToPredicate; to: FromToPredicate }): Config {
      return {
        configPath: "<test>",
        because: "test config",
        classify: fileTags.tags.length === 0 ? [] : [{ glob: fileTags.glob, tags: [...fileTags.tags] }],
        edges: { point: [{ ...rule, because: "a forbidden edge" }] },
      };
    }

    test("a from predicate matches a source that carries every listed tag, unless the source also carries every excluded tag", () => {
      const wrong: string[] = [];
      for (const tags of PREDICATE_TAGS) {
        for (const exclude of [undefined, ...PREDICATE_TAGS]) {
          for (const sourceTags of TAG_SETS) {
            const from: FromToPredicate = exclude === undefined ? { tags } : { tags, exclude: { tags: exclude } };
            const expected = carriesEvery(sourceTags, tags) && !(exclude !== undefined && carriesEvery(sourceTags, exclude)) ? 1 : 0;
            const actual = checkPoint(fakeGraph([edge({})]), pointConfig({ glob: "src/a.ts", tags: sourceTags }, { from, to: "src/b.ts" })).length;
            if (actual !== expected) wrong.push(`from=${JSON.stringify(from)} source=${JSON.stringify(sourceTags)}: expected ${expected}, got ${actual}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    test("a to predicate matches a target that carries every listed tag", () => {
      const wrong: string[] = [];
      for (const tags of PREDICATE_TAGS) {
        for (const targetTags of TAG_SETS) {
          const expected = carriesEvery(targetTags, tags) ? 1 : 0;
          const actual = checkPoint(fakeGraph([edge({})]), pointConfig({ glob: "src/b.ts", tags: targetTags }, { from: "src/a.ts", to: { tags } })).length;
          if (actual !== expected) wrong.push(`to=${JSON.stringify(tags)} target=${JSON.stringify(targetTags)}: expected ${expected}, got ${actual}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  });

  test("a glob predicate never matches an external target, even a glob that matches every path", () => {
    const pointTo = (to: FromToPredicate): Config => ({
      configPath: "<test>",
      because: "test config",
      edges: { point: [{ from: "src/**", to, because: "browser code avoids external packages" }] },
    });
    const builtinFs = externalEdge("a.ts", "node:fs", "node:fs", "fs");
    const npmLodash = externalEdge("b.ts", "lodash", "/project/node_modules/lodash/index.js", "lodash");
    const graph = fakeGraph([builtinFs, npmLodash]);

    expect(checkPoint(graph, pointTo("**"))).toEqual([]);
    // A tag predicate does match the same edges, so the empty result above
    // comes from the glob, not from a from side that matched nothing.
    expect(checkPoint(graph, pointTo({ tags: ["pkg:lodash"] })).map((v) => v.path)).toEqual([npmLodash.fromFile]);
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

  test("a point violation points at the rule that fired, even when an earlier rule shares its from, to, and reason", () => {
    // A lookup that matches a report back to its entry by from, to, and
    // reason finds the first of the two entries. Only the index of the rule
    // that fired tells them apart. The edge filters admit the type-only edge
    // to the second rule alone.
    const fired = { from: "src/a.ts", to: "src/b.ts", edgeType: "type" as const, because: "a may not reach b" };
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      edges: {
        point: [
          { from: "src/a.ts", to: "src/b.ts", edgeType: "value", because: "a may not reach b" },
          fired,
        ],
      },
    };
    const violations = checkPoint(fakeGraph([edge({ isTypeOnly: true })]), cfg);

    expect(violations).toHaveLength(1);
    expect(pointersOf(violations[0]!, cfg)).toEqual([{ pointer: "edges.point[1]", role: "fired", value: fired }]);
  });

  // check --json reports these entries as `edgeRuleCoverage`, and the
  // empty-rule-set check flags a rule whose count is 0. A point rule's from
  // and to are the whole rule, so the count is every edge that its from side
  // matches. A to side that matches no such edge can mean a rule that finds
  // no forbidden edge, which is not a rule that judges nothing.
  test("edge rule coverage names each point rule by its from and to, and counts every edge whose source its from side matches, whatever the target", () => {
    const cfg: Config = {
      configPath: "<test>",
      because: "test config",
      edges: {
        point: [
          { from: "src/a.ts", to: "src/b.ts", because: "a may not reach b" },
          { from: "lib/**", to: "src/**", because: "lib stays below src" },
        ],
      },
    };
    const graph = fakeGraph([
      edge({}),
      edge({ specifier: "./c.js", resolvedFile: "/project/src/c.ts" }),
      edge({ fromFile: "/project/src/d.ts" }),
    ]);

    expect(checkEdgesCoverage(graph, cfg)).toEqual([
      { kind: "point", identifier: "src/a.ts -> src/b.ts", evaluated: 2 },
      { kind: "point", identifier: "lib/** -> src/**", evaluated: 0 },
    ]);
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

  // Each rule below condemns every edge it judges, so a violation means "the
  // filters admitted this edge". The combinations are few (4 x 4 x 2 x 2), so
  // the tests enumerate all of them instead of drawing samples: a filter
  // value that one rule shape mishandles cannot hide behind the draws.
  type EdgeType = "value" | "type" | "both" | undefined;
  type ImportForm = "static" | "dynamic" | "both" | undefined;
  type Filters = { edgeType?: Exclude<EdgeType, undefined>; importForm?: Exclude<ImportForm, undefined> };

  const EDGE_TYPES: readonly EdgeType[] = ["value", "type", "both", undefined];
  const IMPORT_FORMS: readonly ImportForm[] = ["static", "dynamic", "both", undefined];

  function admits(edgeType: EdgeType, importForm: ImportForm, isTypeOnly: boolean, isDynamic: boolean): boolean {
    const byType = edgeType === "value" ? !isTypeOnly : edgeType === "type" ? isTypeOnly : true;
    const byForm = importForm === "static" ? !isDynamic : importForm === "dynamic" ? isDynamic : true;
    return byType && byForm;
  }

  function disagreements(judge: (filters: Filters, edge: Edge) => number): string[] {
    const wrong: string[] = [];
    for (const edgeType of EDGE_TYPES) {
      for (const importForm of IMPORT_FORMS) {
        for (const isTypeOnly of [false, true]) {
          for (const isDynamic of [false, true]) {
            const filters: Filters = {
              ...(edgeType === undefined ? {} : { edgeType }),
              ...(importForm === undefined ? {} : { importForm }),
            };
            const expected = admits(edgeType, importForm, isTypeOnly, isDynamic) ? 1 : 0;
            const actual = judge(filters, edge({ isTypeOnly, isDynamic }));
            if (actual !== expected) {
              wrong.push(
                `edgeType=${edgeType ?? "omitted"} importForm=${importForm ?? "omitted"} ` +
                `isTypeOnly=${isTypeOnly} isDynamic=${isDynamic}: expected ${expected} violation(s), got ${actual}`,
              );
            }
          }
        }
      }
    }
    return wrong;
  }

  test("a point rule judges exactly the edges that its edgeType and importForm admit", () => {
    const wrong = disagreements((filters, judged) => {
      const cfg: Config = {
        configPath: "<test>",
        because: "test config",
        edges: { point: [{ from: "src/a.ts", to: "src/b.ts", ...filters, because: "a may not reach b" }] },
      };
      return checkPoint(fakeGraph([judged]), cfg).length;
    });
    expect(wrong).toEqual([]);
  });

  test("an allowDeny rule judges exactly the edges that its edgeType and importForm admit", () => {
    const wrong = disagreements((filters, judged) => {
      const cfg: Config = {
        configPath: "<test>",
        because: "test config",
        classify: [
          { glob: "src/a.ts", tags: ["domain:framework"] },
          { glob: "src/b.ts", tags: ["domain:sql"] },
        ],
        edges: {
          allowDeny: [{ source: "domain:framework", targetNamespace: "domain", allow: [], ...filters, because: "framework imports no other domain" }],
        },
      };
      return checkAllowDeny(fakeGraph([judged]), cfg).length;
    });
    expect(wrong).toEqual([]);
  });

  test("an order rule judges exactly the edges that its edgeType and importForm admit", () => {
    const wrong = disagreements((filters, judged) => {
      const cfg: Config = {
        configPath: "<test>",
        because: "test config",
        classify: [
          { glob: "src/a.ts", tags: ["layer:core"] },
          { glob: "src/b.ts", tags: ["layer:runtime"] },
        ],
        edges: {
          order: [{
            tagNamespace: "layer",
            sequence: { "": ["core", "runtime"] },
            direction: "downward-only",
            ...filters,
            because: "dependencies flow toward core",
          }],
        },
      };
      return checkOrder(fakeGraph([judged]), cfg).length;
    });
    expect(wrong).toEqual([]);
  });
});
