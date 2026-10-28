// Property: a classify glob is flagged when it matches no real file in
// scope (a declared module's own file, or an outsideFiles entry). A glob
// that matches files is flagged when a longer-prefix entry with different
// tags covers every file it matches, and stays quiet when it still wins
// a file or the winner carries the same tags. The same holds for a
// deprecated entry against a hand-written edge set of the cycles fixture.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileGlob } from "../src/config/classify.js";
import { buildModuleGraph } from "../src/graph/module-graph.js";
import { checkEmptyRuleSet } from "../src/rules/empty-rule.js";
import { createConfigLocator, locateViolations } from "../src/config/config-pointer.js";
import type { Config } from "../src/config/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered"); // a, b, c
const CYCLES_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cycles");

const CYCLES_EDGES = new Set(["a -> b", "b -> c", "c -> a"]);
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

  test("a classify entry that matches files is flagged exactly when a more specific entry supplies different tags for every match", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        { name: "c", glob: "src/c/**", surface: "index.ts" },
      ],
    });
    const rels = [...graph.modules.values()].flatMap((module) => module.files).concat(graph.outsideFiles).map((file) => graph.relativePath(file));
    const specific = gs.sampledFrom(["src/a/**", "src/b/**", "src/c/**"] as const);
    const broadTag = gs.sampledFrom(["kind:broad", "kind:same"] as const);
    assert.deepEqual(rels.map((rel) => rel.split("/")[1]).sort(), ["a", "b", "c"]);

    hegel.test((tc) => {
      const covered = tc.draw(gs.arrays(specific, { minSize: 0, maxSize: 3 }));
      const tag = tc.draw(broadTag);
      const classify = [
        ...covered.map((glob) => ({ glob, tags: ["kind:same"] })),
        { glob: "src/**", tags: [tag] },
      ];
      const config: Config = { configPath: "<test>", because: "property test", classify };
      const violations = checkEmptyRuleSet(graph, config);
      const coveredSet = new Set<string>(covered);
      const everyDirectoryCovered = ["src/a/**", "src/b/**", "src/c/**"].every((glob) => coveredSet.has(glob));
      const broadLoses = tag === "kind:broad" && everyDirectoryCovered;

      if (!broadLoses) {
        assert.deepEqual(violations, []);
        return;
      }
      const count = rels.filter((rel) => compileGlob("src/**").test(rel)).length;
      assert.equal(violations.length, 1);
      assert.equal(violations[0]!.evidence, `classify glob 'src/**' matches ${count} files but a more specific glob supplies their tags`);
      const [located] = locateViolations(violations, config, createConfigLocator(config));
      assert.equal((located!.config as { pointer: string }).pointer, `classify[${covered.length}]`);
    });
  });

  test("a friends entry is flagged exactly when its file is not in the module or its from matches no analyzed file", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-friends-property-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "friend"), { recursive: true });
      writeFileSync(join(root, "src", "core", "internal.ts"), "export const internalThing = 1;\n");
      writeFileSync(join(root, "src", "core", "other.ts"), "export const other = 1;\n");
      writeFileSync(join(root, "src", "friend", "module.ts"), "export const allowed = 1;\n");
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const files = ["internal.ts", "other.ts"] as const;
      const missingFiles = ["missing.ts", "nope.ts"] as const;
      const friend = gs.record({
        file: gs.sampledFrom([...files, ...missingFiles]),
        from: gs.sampledFrom(["src/friend/**", "src/ghost/**"] as const),
      });

      hegel.test((tc) => {
        const drawn = tc.draw(gs.arrays(friend, { minSize: 0, maxSize: 3 }));
        const declaredModules = [
          {
            name: "core",
            glob: "src/core/**",
            surface: "internal.ts",
            friends: drawn.map((entry) => ({ ...entry, because: "property test" })),
          },
          { name: "friend", glob: "src/friend/**", surface: "index.ts" },
        ];
        const graph = buildModuleGraph({ projectRoot: root, declaredModules });
        const config: Config = { configPath: "<test>", because: "property test", declaredModules };
        const violations = checkEmptyRuleSet(graph, config);
        const expected = drawn.flatMap((entry, index) => {
          const misses: string[] = [];
          if (!files.includes(entry.file as (typeof files)[number])) {
            misses.push(`friends file '${entry.file}' on module 'core' matches no file in that module`);
          }
          if (entry.from === "src/ghost/**") {
            misses.push(`friends from '${entry.from}' on module 'core' matches no file in scope`);
          }
          return misses.map((evidence) => ({ index, evidence }));
        });
        assert.deepEqual(violations.map((v) => v.evidence), expected.map((item) => item.evidence));
        const located = locateViolations(violations, config, createConfigLocator(config));
        assert.deepEqual(
          located.map((v) => (v.config as { pointer: string }).pointer),
          expected.map((item) => `declaredModules[0].friends[${item.index}]`),
        );
      }, { testCases: 20 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a deprecated entry is flagged exactly when its own pair has no cross-module edge, at its own index", () => {
    const graph = buildModuleGraph({
      projectRoot: CYCLES_FIXTURE,
      declaredModules: ["a", "b", "c", "d"].map((name) => ({ name, glob: `src/${name}/**` })),
    });
    const pairs = ["a", "b", "c", "d"].flatMap((from) =>
      ["a", "b", "c", "d"].filter((to) => to !== from).map((to) => ({ from, to })));

    hegel.test((tc) => {
      const drawn = tc.draw(gs.arrays(gs.sampledFrom(pairs), { minSize: 0, maxSize: 4 }));
      const deprecated = drawn.map(({ from, to }) => ({ from, to, count: 1, because: "property test" }));
      const config: Config = { configPath: "<test>", because: "property test", deprecated };

      const located = locateViolations(checkEmptyRuleSet(graph, config), config, createConfigLocator(config));

      const expected = drawn.flatMap(({ from, to }, i) =>
        CYCLES_EDGES.has(`${from} -> ${to}`) ? [] : [{ index: i, pointer: `deprecated[${i}]`, pair: `'${from} -> ${to}'` }]);
      assert.equal(located.length, expected.length);
      located.forEach((violation, i) => {
        assert.ok(!Array.isArray(violation.config));
        assert.ok("pointer" in violation.config);
        assert.equal(violation.config.pointer, expected[i]!.pointer);
        assert.equal(violation.config.path, "<test>");
        assert.equal(violation.config.role, "fired");
        assert.equal(violation.config.line, 1);
        assert.equal(violation.config.column, 1);
        assert.deepEqual(violation.config.value, deprecated[expected[i]!.index]);
      });
      located.forEach((v, i) => assert.ok(v.do.includes(expected[i]!.pair)));
    }, { testCases: 20 });
  });
});

test("adding a real target outside allow removes the exhaustive finding", () => {
  hegel.test(tc => {
    const values = tc.draw(gs.arrays(gs.integers(), { minSize: 1, unique: true })).map(value => `v${value}`);
    const root = mkdtempSync(join(tmpdir(), "archstrict-allow-property-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
      writeFileSync(join(root, "src/app.ts"), 'import "./target.js";');
      writeFileSync(join(root, "src/target.ts"), 'export const value = 1;');
      const config: Config = { configPath: "<test>", because: "test", declaredModules: [{ name: "all", glob: "src/**" }],
        classify: [{ glob: "src/app.ts", tags: ["role:app"] },
          { glob: "src/target.ts", tags: values.map(value => `role:${value}`) },
          { glob: "src/new.ts", tags: ["role:new"] }],
        edges: { allowDeny: [{ source: "role:app", targetNamespace: "role", allow: values, because: "test" }] } };
      const findings = () => checkEmptyRuleSet(buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! }), config)
        .filter(v => v.rule === "exhaustive-allow-list");
      assert.equal(findings().length, 1);
      writeFileSync(join(root, "src/new.ts"), 'export const value = 2;');
      writeFileSync(join(root, "src/other.ts"), 'import "./new.js";');
      assert.equal(findings().length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { testCases: 20 });
});

test("a guard rule with no edge to judge is reported exactly when its source tags no file, its target namespace is unknown, or a deny value in a classify namespace is not assigned", () => {
  const graph = buildModuleGraph({
    projectRoot: FIXTURE,
    declaredModules: ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**`, surface: "index.ts" })),
  });
  const rule = gs.record({
    source: gs.sampledFrom(["kind:a", "kind:b", "kind:ghost"]),
    targetNamespace: gs.sampledFrom(["kind", "pkg", "ghost"]),
    deny: gs.sampledFrom(["a", "b", "x"]),
    guard: gs.booleans(),
  });

  hegel.test((tc) => {
    const rules = tc.draw(gs.arrays(rule, { minSize: 1, maxSize: 4 }));
    const config: Config = {
      configPath: "<test>",
      because: "property test",
      classify: [{ glob: "src/a/**", tags: ["kind:a"] }, { glob: "src/b/**", tags: ["kind:b"] }],
      edges: { allowDeny: rules.map((r) => ({ ...r, deny: [r.deny], because: "property test" })) },
    };
    const expected = rules.flatMap((r, i) => !r.guard || r.source === "kind:ghost" || r.targetNamespace === "ghost" || (r.targetNamespace === "kind" && r.deny === "x") ? [`edges.allowDeny[${i}]`] : []);
    const located = locateViolations(checkEmptyRuleSet(graph, config), config, createConfigLocator(config));
    assert.deepEqual(located.map((v) => (v.config as { pointer: string }).pointer), expected);
  });
});
