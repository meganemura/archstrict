// Property: for any glob and any set of generated file paths, a violation
// occurs if and only if at least one path matches - checked against an
// independent reference match (plain string prefix, since every generated
// glob here is a literal directory prefix plus "**"), not against the
// rule's own compileGlob.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { checkMustBeEmpty } from "../src/rules/must-be-empty.js";

const segment = gs.fromRegex("[a-z][a-z0-9]{2,6}");
const path = gs.arrays(segment, { minSize: 1, maxSize: 4 }).map((parts) => parts.join("/") + ".ts");
const paths = gs.arrays(path, { minSize: 0, maxSize: 8 });

describe("checkMustBeEmpty (property)", () => {
  test("a violation occurs for exactly the paths that start with the glob's own literal prefix", () => {
    hegel.test((tc) => {
      const dir = tc.draw(segment);
      const generatedPaths = tc.draw(paths);
      const glob = `${dir}/**`;

      const violations = checkMustBeEmpty(generatedPaths, { mustBeEmpty: [{ glob, because: "property test" }] });
      const expectedMatches = generatedPaths.filter((p) => p.startsWith(`${dir}/`));

      assert.equal(violations.length, expectedMatches.length);
      assert.deepEqual(
        violations.map((v) => v.path).sort(),
        [...expectedMatches].sort(),
      );
    });
  });
});
