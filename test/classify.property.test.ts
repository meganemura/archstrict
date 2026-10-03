// Property: for any two overlapping classify entries of different
// specificity (a longer literal prefix, or an equal prefix with fewer
// wildcards), the more specific one wins regardless of declaration order -
// the property a config author (or the agent editing one) depends on,
// since nothing enforces a particular entry order.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { classifyByGlob } from "../src/classify.js";

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
});
