// Responsibility: the classify list recommend measures and shows gives every file the config's tags plus the proposal's.
// Boundary: mergeClassify only; recommend's own detectors are covered by recommend.test.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { AmbiguousClassifyError, classifyByGlob } from "../src/classify.js";
import { mergeClassify } from "../src/verbs/recommend.js";

const FILES = ["src/a/index.ts", "src/a/x.ts", "src/a/deep/y.ts", "src/b/index.ts", "src/b/x.ts", "src/c.ts", "test/a.ts"];
const GLOBS = ["**", "src/**", "src/a/**", "src/a/*", "src/a/x.ts", "src/b/**", "src/b/*.ts", "src/*.ts", "src/c.ts", "test/**", "src/a/deep/**"];

function entries(namespace: string) {
  return gs.arrays(gs.record({ glob: gs.sampledFrom(GLOBS), tags: gs.arrays(gs.sampledFrom(["1", "2", "3"]).map(v => `${namespace}:${v}`), { minSize: 1, maxSize: 2 }) }), { maxSize: 5 });
}

function tagsOf(file: string, list: readonly { glob: string; tags: readonly string[] }[]): string[] | "ambiguous" {
  try {
    return [...new Set(classifyByGlob(file, list) ?? [])].sort();
  } catch (error) {
    if (error instanceof AmbiguousClassifyError) return "ambiguous";
    throw error;
  }
}

test("every file the config and the proposal each tag unambiguously carries both tag sets under the merged list", () => {
  hegel.test((tc) => {
    const base = tc.draw(entries("layer"));
    const added = tc.draw(entries("role"));
    tc.assume(FILES.every(file => tagsOf(file, base) !== "ambiguous" && tagsOf(file, added) !== "ambiguous"));
    const merged = mergeClassify(FILES, base, added);
    for (const file of FILES) {
      const expected = [...new Set([...tagsOf(file, base), ...tagsOf(file, added)])].sort();
      assert.deepEqual(tagsOf(file, merged), expected, `${file} in ${JSON.stringify(merged)}`);
    }
  });
});
