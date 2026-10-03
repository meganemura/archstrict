// Responsibility: properties of the constraint rules over generated rules and
// edges. An edge within the same allow-list entry (source and target share
// the rule's own tag) never violates - the "same group as source is
// unconstrained" rule constraints.ts's own header documents. An exceptions
// list exempts exactly the edges that one entry matches on both sides. A
// rule naming a package matches the edge resolved through its
// DefinitelyTyped identity. All three rule shapes return their violations
// in one position order, whatever order the graph lists its edges in. A
// run scoped to one file reports exactly the whole-project violations at
// that file.
// Boundary: fabricated graphs only. Exact violation text, fixture-backed
// cases, and small finite domains that tests enumerate in full belong to
// test/constraints.test.ts.
// The checks read `edges` and the relative-path converter.
// classifyFile reads project-relative paths. A fabricated graph is enough,
// with no fixture tree to write per case.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { checkAllowDeny, checkOrder, checkPoint, type ConstraintViolation } from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";
import type { Edge, ModuleGraph } from "../src/module-graph.js";
import { makeProjectRelativePosix } from "../src/project-path.js";

const DOMAINS = ["framework", "sql", "targets"] as const;
const LAYERS = ["core", "runtime"] as const;

function fakeGraph(edges: Edge[]): Pick<ModuleGraph, "edges" | "rootDir" | "relativePath"> {
  return { edges, rootDir: "/project", relativePath: makeProjectRelativePosix("/project") };
}

function edgeFromAToB(overrides: Partial<Edge> = {}): Edge {
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

const GLOB_MATCHES: Readonly<Record<string, readonly string[]>> = {
  "**": ["src/a.ts", "src/b.ts"],
  "src/*.ts": ["src/a.ts", "src/b.ts"],
  "src/a.ts": ["src/a.ts"],
  "src/b.ts": ["src/b.ts"],
  "lib/**": [],
};

// Package names as npm spells them, without the "_" that DefinitelyTyped
// uses to encode a scope.
const packageName = gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-", minSize: 1, maxSize: 12 });

describe("checkAllowDeny (property)", () => {
  test("an edge within the same domain never violates, regardless of the domain's own allow list", () => {
    hegel.test((tc) => {
      const domain = tc.draw(gs.sampledFrom([...DOMAINS]));
      const sourceLayer = tc.draw(gs.sampledFrom([...LAYERS]));
      const targetLayer = tc.draw(gs.sampledFrom([...LAYERS]));
      const allow = tc.draw(gs.arrays(gs.sampledFrom(DOMAINS.filter((d) => d !== domain)), { maxSize: 2 }));

      const config: Config = {
        configPath: "<test>",
        because: "test config",
        classify: [
          { glob: "src/a.ts", tags: [`domain:${domain}`, `layer:${sourceLayer}`] },
          { glob: "src/b.ts", tags: [`domain:${domain}`, `layer:${targetLayer}`] },
        ],
        edges: {
          allowDeny: [{ source: `domain:${domain}`, targetNamespace: "domain", allow, because: "property test" }],
        },
      };

      const violations = checkAllowDeny(fakeGraph([edgeFromAToB()]) as ModuleGraph, config);
      assert.equal(violations.length, 0);
    });
  });

  test("an exceptions list exempts an edge exactly when one entry matches both the edge's source and its target", () => {
    hegel.test((tc) => {
      const glob = gs.sampledFrom(Object.keys(GLOB_MATCHES));
      const pairs = tc.draw(gs.arrays(gs.tuples(glob, glob), { maxSize: 4 }));
      const exceptions = pairs.map(([from, to]) => ({ from, to, because: "a documented exception" }));

      const config: Config = {
        configPath: "<test>",
        because: "test config",
        classify: [
          { glob: "src/a.ts", tags: ["domain:framework"] },
          { glob: "src/b.ts", tags: ["domain:sql"] },
        ],
        edges: {
          allowDeny: [{ source: "domain:framework", targetNamespace: "domain", allow: [], exceptions, because: "framework imports no other domain" }],
        },
      };

      const exempt = exceptions.some((ex) => GLOB_MATCHES[ex.from]!.includes("src/a.ts") && GLOB_MATCHES[ex.to]!.includes("src/b.ts"));
      const violations = checkAllowDeny(fakeGraph([edgeFromAToB()]) as ModuleGraph, config);
      assert.equal(violations.length, exempt ? 0 : 1);
    }, { testCases: 50 });
  });

  // A package without bundled types resolves to its DefinitelyTyped identity,
  // so a rule author who names the package itself must still match the edge.
  test("a deny rule naming either the package or its DefinitelyTyped identity fires on an edge resolved through that identity", () => {
    hegel.test((tc) => {
      const name = tc.draw(packageName);
      const scope = tc.draw(gs.booleans()) ? tc.draw(packageName) : undefined;
      // DefinitelyTyped spells the scoped package "@scope/name" as "@types/scope__name".
      const bare = scope === undefined ? name : `@${scope}/${name}`;
      const shadow = scope === undefined ? `@types/${name}` : `@types/${scope}__${name}`;
      const graph = fakeGraph([edgeFromAToB({
        fromFile: "/project/src/browser/a.ts",
        specifier: bare,
        resolvedFile: `/project/node_modules/${shadow}/index.d.ts`,
        toModule: undefined,
        externalPackage: shadow,
      })]) as ModuleGraph;
      const denying = (deny: string[]): Config => ({
        configPath: "<test>",
        because: "test config",
        classifyByDirectoryName: { tagNamespace: "env", names: ["browser"] },
        edges: { allowDeny: [{ source: "env:browser", targetNamespace: "pkg", deny, because: "browser code avoids these packages" }] },
      });

      assert.equal(checkAllowDeny(graph, denying([bare])).length, 1);
      assert.equal(checkAllowDeny(graph, denying([shadow])).length, 1);
    }, { testCases: 20 });
  });
});

// "src/B.ts" sorts before "src/a.ts" by code units but after it by a
// locale-aware compare, which can differ between machines.
const SOURCE_PATHS = ["src/a.ts", "src/b.ts", "src/B.ts"] as const;
// Few lines and columns make edges that share a path, or a path and a line,
// common. Only such pairs reach the line and column tie-breaks.
const coordinate = gs.integers({ minValue: 1, maxValue: 2 });
const position = gs.tuples(gs.sampledFrom(SOURCE_PATHS), coordinate, coordinate);

function edgesIntoLib(positions: readonly (readonly [string, number, number])[]): Edge[] {
  return positions.map(([path, line, column]) =>
    edgeFromAToB({ fromFile: `/project/${path}`, fromPosition: { line, column }, resolvedFile: "/project/lib/t.ts" }));
}

// One rule of each shape, each condemning every edge from src/ into lib/,
// so each check reports exactly one violation per edge.
const SRC_MUST_NOT_REACH_LIB: Config = {
  configPath: "<test>",
  because: "test config",
  classify: [
    { glob: "src/**", tags: ["side:src", "layer:core"] },
    { glob: "lib/**", tags: ["side:lib", "layer:runtime"] },
  ],
  edges: {
    allowDeny: [{ source: "side:src", targetNamespace: "side", allow: [], because: "src imports nothing from lib" }],
    order: [{ tagNamespace: "layer", sequence: { "": ["core", "runtime"] }, direction: "downward-only", because: "dependencies flow toward core" }],
    point: [{ from: "src/**", to: "lib/**", because: "src imports nothing from lib" }],
  },
};

// The graph's edge order follows a directory scan, so it is no promise to a
// reader. A report must not change when that scan order changes.
describe("violation order (property)", () => {
  type Position = Pick<ConstraintViolation, "path" | "line" | "column">;
  const key = (p: Position) => `${p.path}:${p.line}:${p.column}`;

  function inPositionOrder(p: Position, q: Position): boolean {
    if (p.path !== q.path) return p.path < q.path;
    if (p.line !== q.line) return p.line < q.line;
    return p.column <= q.column;
  }

  test("every rule shape returns its violations by path in code-unit order, then line, then column, whatever the edge order", () => {
    hegel.test((tc) => {
      const edges = edgesIntoLib(tc.draw(gs.arrays(position, { minSize: 3, maxSize: 6 })));
      const graph = fakeGraph(edges) as ModuleGraph;
      const expected = edges.map((e) => key({ path: e.fromFile, line: e.fromPosition.line, column: e.fromPosition.column })).sort();

      for (const check of [checkAllowDeny, checkOrder, checkPoint]) {
        const violations = check(graph, SRC_MUST_NOT_REACH_LIB);
        assert.deepEqual(violations.map(key).sort(), expected, `${check.name} reports one violation per edge`);
        for (let i = 1; i < violations.length; i++) {
          assert.ok(
            inPositionOrder(violations[i - 1]!, violations[i]!),
            `${check.name}: ${key(violations[i - 1]!)} comes before ${key(violations[i]!)}`,
          );
        }
      }
    }, { testCases: 50 });
  });
});

describe("scoped run (property)", () => {
  test("every rule shape scoped to one file reports exactly the whole-project violations at that file", () => {
    hegel.test((tc) => {
      const edges = edgesIntoLib(tc.draw(gs.arrays(position, { minSize: 2, maxSize: 5 })));
      const graph = fakeGraph(edges) as ModuleGraph;

      const focus = tc.draw(gs.sampledFrom(edges.map((e) => e.fromFile)));

      for (const check of [checkAllowDeny, checkOrder, checkPoint]) {
        const whole = check(graph, SRC_MUST_NOT_REACH_LIB);
        assert.deepEqual(check(graph, SRC_MUST_NOT_REACH_LIB, focus), whole.filter((v) => v.path === focus), check.name);
      }
    }, { testCases: 30 });
  });
});
