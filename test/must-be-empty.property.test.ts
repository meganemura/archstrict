// Properties: for any glob and any set of generated file paths, a violation
// occurs if and only if at least one path matches - checked against an
// independent reference match (plain string prefix, since every generated
// glob here is a literal directory prefix plus "**"), not against the
// rule's own compileGlob. And the violations come out in one order however
// the caller orders its file list.
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

  test("the violations come out in the same order whatever order the file list is in", () => {

    const shuffle = <T>(items: readonly T[], keys: readonly number[]): T[] =>
      items.map((item, i) => ({ item, key: keys[i]! })).sort((x, y) => x.key - y.key).map(({ item }) => item);
    hegel.test((tc) => {
      const dir = tc.draw(segment);

      const inside = tc.draw(gs.arrays(path, { minSize: 2, maxSize: 6 })).map((p) => `${dir}/${p}`);
      const keys = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { minSize: inside.length, maxSize: inside.length }));
      const config = { mustBeEmpty: [{ glob: `${dir}/**`, because: "property test" }] };

      const reference = [...inside].sort();
      assert.deepEqual(checkMustBeEmpty(inside, config).map(v => v.path), reference);

      for (const order of [shuffle(inside, keys), [...inside].reverse()]) {
        assert.deepEqual(checkMustBeEmpty(order, config).map((v) => v.path), reference);
      }
    }, { testCases: 50 });
  });
});
