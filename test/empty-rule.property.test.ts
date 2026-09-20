// Property: a classify glob is flagged exactly when it matches no real file
// in scope (a declared module's own file, or an outsideFiles entry) —
// checked against an independently computed expected set, not against
// checkEmptyRuleSet re-deriving its own answer.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkEmptyRuleSet } from "../src/rules/empty-rule.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered"); // a, b, c
// "nonexistent" and "ghost" name no real directory; kept alongside the
// fixture's own module names rather than a separately hardcoded "doesn't
// match" list, so drawing one of them always means "matches nothing"
// regardless of what the fixture happens to hold.
const CANDIDATE_GLOBS = ["src/a/**", "src/b/**", "src/c/**", "src/nonexistent/**", "src/ghost/**"] as const;

const classifyEntry = gs.record({
  glob: gs.sampledFrom([...CANDIDATE_GLOBS]),
  tag: gs.fromRegex("kind:[a-z]{3,6}"),
});
const classifyEntries = gs.arrays(classifyEntry, { minSize: 0, maxSize: 5 });

describe("checkEmptyRuleSet (property)", () => {
  test("a classify entry is flagged exactly when its glob matches no real file", () => {
    // Built once: the fixture's files don't change between draws, only
    // `classify` does, so there is no reason to rebuild a ts.Program (an
    // expensive real compile) on every one of hegel's iterations.
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        { name: "c", glob: "src/c/**", surface: "index.ts" },
      ],
    });
    const matchingGlobs = new Set(["src/a/**", "src/b/**", "src/c/**"]);

    hegel.test((tc) => {
      const entries = tc.draw(classifyEntries);
      const classify = entries.map(({ glob, tag }) => ({ glob, tags: [tag] }));

      const config: Config = { configPath: "<test>", because: "property test", classify };
      const violations = checkEmptyRuleSet(graph, config);

      const expectedEmptyGlobs = entries.filter(({ glob }) => !matchingGlobs.has(glob));

      assert.equal(violations.length, expectedEmptyGlobs.length);
      for (const v of violations) {
        assert.ok(v.rule === "empty-rule-set");
        assert.ok(expectedEmptyGlobs.some(({ glob }) => v.evidence.includes(`'${glob}'`)));
      }
    });
  });
});
