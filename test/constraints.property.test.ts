// Property: an edge within the same allow-list entry (source and target
// share the rule's own tag) never violates - the "same group as source is
// unconstrained" rule constraints.ts's own header documents.
// checkAllowDeny reads `edges` and the relative-path converter.
// classifyFile reads project-relative paths. A fabricated graph is enough,
// with no fixture tree to write per case.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { checkAllowDeny } from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";
import type { Edge, ModuleGraph } from "../src/module-graph.js";
import { makeProjectRelativePosix } from "../src/project-path.js";

const DOMAINS = ["framework", "sql", "targets"] as const;
const LAYERS = ["core", "runtime"] as const;

function fakeGraph(edges: Edge[]): Pick<ModuleGraph, "edges" | "rootDir" | "relativePath"> {
  return { edges, rootDir: "/project", relativePath: makeProjectRelativePosix("/project") };
}

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

      const edge: Edge = {
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
      };

      const violations = checkAllowDeny(fakeGraph([edge]) as ModuleGraph, config);
      assert.equal(violations.length, 0);
    });
  });
});
