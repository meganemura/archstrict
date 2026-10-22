// Property: for any two overlapping classify entries of different
// specificity (a longer literal prefix, or an equal prefix with fewer
// wildcards), the more specific one wins regardless of declaration order -
// the property a config author (or the agent editing one) depends on,
// since nothing enforces a particular entry order.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { classifyByGlob, compileGlob } from "../src/classify.js";

const segment = gs.fromRegex("[a-z][a-z0-9]{2,6}");

describe("classifyByGlob (property)", () => {
  test("the more specific of two matching entries wins, independent of order", () => {
    hegel.test((tc) => {
      const dir = tc.draw(segment);
      const file = tc.draw(segment);

      const broad = { glob: `${dir}/**`, tags: ["broad"] };
      const specific = { glob: `${dir}/${file}.ts`, tags: ["specific"] };
      const path = `${dir}/${file}.ts`;

      assert.deepEqual(classifyByGlob(path, [broad, specific]), ["specific"]);
      assert.deepEqual(classifyByGlob(path, [specific, broad]), ["specific"]);
    });
  });

  test("with equal literal prefixes, the entry with fewer wildcards wins, independent of order", () => {
    hegel.test((tc) => {
      const dir = tc.draw(segment);
      const file = tc.draw(segment);

      const broad = { glob: `${dir}/**`, tags: ["broad"] };
      const specific = { glob: `${dir}/*.ts`, tags: ["specific"] };
      const path = `${dir}/${file}.ts`;

      assert.deepEqual(classifyByGlob(path, [broad, specific]), ["specific"]);
      assert.deepEqual(classifyByGlob(path, [specific, broad]), ["specific"]);
    });
  });

  test("a leading **/ matches a root file and the same name under a directory, and a prefixed **/ does not match the root", () => {
    hegel.test((tc) => {
      const name = tc.draw(segment);
      const ext = tc.draw(gs.sampledFrom(["ts", "tsx"] as const));
      const file = `${name}.${ext}`;
      const leading = compileGlob(`**/*.${ext}`);
      assert.equal(leading.test(file), true);
      assert.equal(leading.test(`src/${file}`), true);
      assert.equal(leading.test(`src/app/${file}`), true);
      assert.equal(leading.test(`${name}.js`), false);
      assert.equal(compileGlob(`src/**/*.${ext}`).test(file), false);
      assert.equal(compileGlob(`src/**/*.${ext}`).test(`src/${file}`), true);
    });
  });
});
