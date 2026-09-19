// Property: a "kind matches no module" violation occurs exactly for the
// kinds entries whose pattern names a module that doesn't exist among the
// fixture's real modules (a, b, c) — checked against an independently
// computed expected set, not against checkEmptyRuleSet re-deriving its own
// answer.
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
const REAL_MODULES = new Set(["a", "b", "c"]);
const CANDIDATE_NAMES = ["a", "b", "c", "x", "y"] as const; // x, y name no real module

const kindEntry = gs.record({
  name: gs.fromRegex("kind[0-9]"),
  moduleName: gs.sampledFrom([...CANDIDATE_NAMES]),
});
const kindEntries = gs.arrays(kindEntry, { minSize: 0, maxSize: 5 });

describe("checkEmptyRuleSet (property)", () => {
  test("a kind is flagged exactly when its named module does not exist", () => {
    // Built once: the fixture's files don't change between draws, only
    // `kinds` does, so there is no reason to rebuild a ts.Program (an
    // expensive real compile) on every one of hegel's iterations.
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });

    hegel.test((tc) => {
      const entries = tc.draw(kindEntries);
      const kinds: Record<string, string> = {};
      // A later entry with the same name overwrites an earlier one, same as
      // any object literal assignment — the expected set below must use
      // this same last-write-wins semantics, not the raw draw list, or two
      // entries sharing a name (one naming a real module, one not) would
      // disagree with what `kinds` actually ends up holding.
      for (const { name, moduleName } of entries) kinds[name] = `src/${moduleName}`;

      const config: Config = { configPath: "<test>", modules: "src/*", kinds, because: "property test" };
      const violations = checkEmptyRuleSet(graph, config);

      const expectedEmptyKinds = new Set(
        Object.entries(kinds)
          .filter(([, pattern]) => !REAL_MODULES.has(pattern.slice("src/".length)))
          .map(([name]) => name),
      );

      assert.equal(violations.length, expectedEmptyKinds.size);
      for (const v of violations) {
        assert.ok(v.rule === "empty-rule-set");
        assert.ok([...expectedEmptyKinds].some((k) => v.evidence.includes(`'${k}'`)));
      }
    });
  });
});
