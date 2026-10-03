// Property: a pointer resolves to the same value in the loaded config and
// its location starts at the selected config entry despite formatting noise.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Config } from "../src/config.js";
import { createConfigLocator, locateViolation } from "../src/config-pointer.js";
import { buildModuleGraph } from "../src/module-graph.js";
import { runRules } from "../src/verbs/check.js";

const whitespace = gs.sampledFrom([" ", "  ", "\n  ", "\n    /* entry */ "]);
function sourceOffset(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  return lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
}

describe("createConfigLocator", () => {
  test("locates a nested value through an export default satisfies expression", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-"));
    try {
      const configPath = join(root, "archstrict.config.ts");
      const source = [
        'import type { Config } from "archstrict";',
        "export default {",
        '  because: "test",',
        "  declaredModules: [],",
        "  deprecated: [",
        '    { from: "a", to: "b", count: 3, because: "remove it" },',
        "  ],",
        "} satisfies Config;",
        "",
      ].join("\n");
      writeFileSync(configPath, source);
      const config: Config = {
        configPath,
        because: "test",
        declaredModules: [],
        deprecated: [{ from: "a", to: "b", count: 3, because: "remove it" }],
      };

      assert.deepEqual(createConfigLocator(config).pointer("deprecated[0].count", "fired"), {
        path: configPath,
        pointer: "deprecated[0].count",
        value: 3,
        line: 6,
        column: 34,
        role: "fired",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the array literal after a spread changes runtime indices", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-spread-"));
    try {
      const configPath = join(root, "archstrict.config.ts");
      const source = [
        'const shared = [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }];',
        "export default {",
        '  declaredModules: [...shared, { name: "c", glob: "src/c/**" }, { name: "d", glob: "src/d/**" }],',
        '  because: "test",',
        "};",
        "",
      ].join("\n");
      writeFileSync(configPath, source);
      const config: Config = { configPath, because: "test", declaredModules: [
        { name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" },
        { name: "c", glob: "src/c/**" }, { name: "d", glob: "src/d/**" },
      ] };

      const pointer = createConfigLocator(config).pointer("declaredModules[2]", "governs");
      assert.deepEqual(pointer.value, { name: "c", glob: "src/c/**" });
      assert.deepEqual({ line: pointer.line, column: pointer.column }, { line: 3, column: 20 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the object literal when a later spread replaces a property", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-object-spread-"));
    try {
      const configPath = join(root, "archstrict.config.ts");
      const source = [
        'const override = { declaredModules: [{ name: "b", glob: "src/b/**" }] };',
        "export default {",
        '  declaredModules: [{ name: "a", glob: "src/a/**" }],',
        "  ...override,",
        '  because: "test",',
        "};",
        "",
      ].join("\n");
      writeFileSync(configPath, source);
      const config: Config = { configPath, because: "test", declaredModules: [{ name: "b", glob: "src/b/**" }] };

      const pointer = createConfigLocator(config).pointer("declaredModules", "governs");
      assert.deepEqual(pointer.value, [{ name: "b", glob: "src/b/**" }]);
      assert.deepEqual({ line: pointer.line, column: pointer.column }, { line: 2, column: 16 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generated entry order, whitespace, and comments preserve value and entry location", () => {
    hegel.test((tc) => {
      const gap = tc.draw(whitespace);
      const reverse = tc.draw(gs.booleans());
      const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-property-"));
      try {
        const configPath = join(root, "archstrict.config.ts");
        const entries = reverse
          ? ['{ name: "b", glob: "src/b/**" }', '{ name: "a", glob: "src/a/**" }']
          : ['{ name: "a", glob: "src/a/**" }', '{ name: "b", glob: "src/b/**" }'];
        const source = `export default {${gap}because: "test",${gap}declaredModules: [${gap}${entries.join(`,${gap}`)}${gap}]${gap}};\n`;
        writeFileSync(configPath, source);
        const declaredModules = reverse
          ? [{ name: "b", glob: "src/b/**" }, { name: "a", glob: "src/a/**" }]
          : [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }];
        const config: Config = { configPath, because: "test", declaredModules };
        const locator = createConfigLocator(config);
        const selectedModule = declaredModules[1]!;
        const violations = [
          locateViolation({ rule: "public-surface-bypass", path: "/source.ts", line: 1, column: 1,
            evidence: "bypass", because: "surface", do: "fix", todoModule: selectedModule.name }, config, locator),
          locateViolation({ rule: "uncovered-module", path: "/outside.ts", line: 1, column: 1,
            evidence: "outside", because: "coverage", do: "declare" }, config, locator),
        ];
        const offset = source.indexOf(entries[1]!);
        const prefix = source.slice(0, offset);
        const expectedLine = prefix.split("\n").length;
        const expectedColumn = offset - prefix.lastIndexOf("\n");
        const modulePointer = Array.isArray(violations[0]!.config) ? violations[0]!.config[0]! : violations[0]!.config;
        const arrayPointer = Array.isArray(violations[1]!.config) ? violations[1]!.config[0]! : violations[1]!.config;
        assert.equal(modulePointer.pointer, "declaredModules[1]");
        assert.equal(modulePointer.role, "governs");
        assert.deepEqual(modulePointer.value, declaredModules[1]);
        assert.equal(arrayPointer.pointer, "declaredModules");
        assert.equal(arrayPointer.role, "governs");
        assert.deepEqual(arrayPointer.value, declaredModules);
        assert.deepEqual({ line: modulePointer.line, column: modulePointer.column },
          { line: expectedLine, column: expectedColumn });
        const arrayOffset = source.indexOf("[", source.indexOf("declaredModules"));
        const arrayPrefix = source.slice(0, arrayOffset);
        assert.deepEqual({ line: arrayPointer.line, column: arrayPointer.column }, {
          line: arrayPrefix.split("\n").length,
          column: arrayOffset - arrayPrefix.lastIndexOf("\n"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 30 });
  });

  test("all generated violation kinds resolve every pointer to its runtime value and config text", () => {
    hegel.test((tc) => {
      const gap = tc.draw(whitespace);
      const reverse = tc.draw(gs.booleans());
      const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-all-rules-"));
      try {
        const configPath = join(root, "archstrict.config.ts");
        const modules = reverse
          ? ['{ name: "b", glob: "src/b/**" }', '{ name: "a", glob: "src/a/**" }']
          : ['{ name: "a", glob: "src/a/**" }', '{ name: "b", glob: "src/b/**" }'];
        const source = `export default {${gap}because: "test",${gap}declaredModules: [${modules.join(`,${gap}`)}],${gap}` +
          `strict: ["a"],${gap}ignoredCycles: [["a", "b"]],${gap}` +
          `classify: [{ glob: "src/ghost/**", tags: ["layer:ghost"] }],${gap}` +
          `mustBeEmpty: [{ glob: "src/empty/**", because: "keep empty" }],${gap}` +
          `deprecated: [{ from: "a", to: "b", count: 2, because: "remove edge" }],${gap}` +
          `edges: { allowDeny: [{ source: "layer:a", targetNamespace: "layer", deny: ["secret"], because: "deny secret" }, ` +
          `{ source: "layer:a", targetNamespace: "layer", allow: ["a"], because: "allow a" }], ` +
          `order: [{ tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "layer order" }], ` +
          `point: [{ from: "src/a/**", to: "src/b/**", because: "no point edge" }] }${gap}};\n`;
        writeFileSync(configPath, source);
        const declaredModules = reverse
          ? [{ name: "b", glob: "src/b/**" }, { name: "a", glob: "src/a/**" }]
          : [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }];
        const config: Config = {
          configPath, because: "test", declaredModules, strict: ["a"], ignoredCycles: [["a", "b"]],
          classify: [{ glob: "src/ghost/**", tags: ["layer:ghost"] }],
          mustBeEmpty: [{ glob: "src/empty/**", because: "keep empty" }],
          deprecated: [{ from: "a", to: "b", count: 2, because: "remove edge" }],
          edges: {
            allowDeny: [
              { source: "layer:a", targetNamespace: "layer", deny: ["secret"], because: "deny secret" },
              { source: "layer:a", targetNamespace: "layer", allow: ["a"], because: "allow a" },
            ],
            order: [{ tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "layer order" }],
            point: [{ from: "src/a/**", to: "src/b/**", because: "no point edge" }],
          },
        };
        const base = { path: "/source.ts", line: 1, column: 1, do: "fix" };
        const target = declaredModules.find((entry) => entry.name === "b")!;
        const violations = [
          { ...base, rule: "public-surface-bypass", evidence: "bypass", because: "surface", todoModule: target.name },
          { ...base, rule: "type-leak", evidence: "leak", because: "surface", todoModule: target.name },
          { ...base, rule: "uncovered-module", evidence: "outside", because: "coverage" },
          { ...base, rule: "cycle", evidence: "a -> b -> a", because: "cycle", todoModule: "a" },
          { ...base, rule: "stale-cycle-exception", evidence: "ignoredCycles entry ['a', 'b'] names no real cycle", because: "stale" },
          { ...base, rule: "must-be-empty", evidence: "'src/empty/x.ts' matches 'src/empty/**'", because: "keep empty" },
          { ...base, rule: "deprecated-edge-increased", evidence: "a -> b: declared count 2, actual 3", because: "remove edge" },
          { ...base, rule: "tag-boundary", evidence: "'x' (from 'layer:a') reaches 'layer:secret'", because: "deny secret" },
          { ...base, rule: "tag-order", evidence: "'x' reaches 'layer:b' from 'layer:a' (layer sequence: a -> b)", because: "layer order" },
          { ...base, rule: "point-rule", evidence: "'x' matches a forbidden edge", because: "no point edge", do: "narrow 'src/a/** -> src/b/**'" },
          { ...base, rule: "empty-rule-set", evidence: "classify glob 'src/ghost/**' matches no file in scope", because: "empty" },
          { ...base, rule: "exhaustive-allow-list", evidence: "allowDeny rule 'layer:a -> layer' allows every value", because: "allow a" },
          { ...base, rule: "clean-module-has-todo", evidence: "module 'a' is configured to stay clean", because: "clean" },
          { ...base, rule: "stale-todo", evidence: "stale", because: "stale" },
          { ...base, rule: "config-meaning", evidence: "allowDeny rule (source 'layer:a')", because: "deny secret" },
        ];
        const locator = createConfigLocator(config);
        const targetIndex = reverse ? 0 : 1;
        const anchorIndex = reverse ? 1 : 0;
        const expectedPointers: Record<string, string[]> = {
          "public-surface-bypass": [`declaredModules[${targetIndex}]`],
          "type-leak": [`declaredModules[${targetIndex}]`],
          "uncovered-module": ["declaredModules"],
          cycle: [`declaredModules[${anchorIndex}]`, "ignoredCycles"],
          "stale-cycle-exception": ["ignoredCycles[0]"],
          "must-be-empty": ["mustBeEmpty[0]"],
          "deprecated-edge-increased": ["deprecated[0].count"],
          "tag-boundary": ["edges.allowDeny[0].deny[0]", "edges.allowDeny[0].allow"],
          "tag-order": ["edges.order[0].sequence"],
          "point-rule": ["edges.point[0]"],
          "empty-rule-set": ["classify[0]"],
          "exhaustive-allow-list": ["edges.allowDeny[1].allow"],
          "clean-module-has-todo": ["strict[0]"],
          "stale-todo": ["declaredModules"],
          "config-meaning": ["edges.allowDeny[0]"],
        };
        const expectedValues: Record<string, unknown> = {
          [`declaredModules[${targetIndex}]`]: target,
          [`declaredModules[${anchorIndex}]`]: declaredModules[anchorIndex],
          declaredModules,
          ignoredCycles: [["a", "b"]],
          "ignoredCycles[0]": ["a", "b"],
          "mustBeEmpty[0]": config.mustBeEmpty![0],
          "deprecated[0].count": 2,
          "edges.allowDeny[0].deny[0]": "secret",
          "edges.allowDeny[0].allow": null,
          "edges.order[0].sequence": { "": ["a", "b"] },
          "edges.point[0]": config.edges!.point![0],
          "classify[0]": config.classify![0],
          "edges.allowDeny[1].allow": ["a"],
          "strict[0]": "a",
          "edges.allowDeny[0]": config.edges!.allowDeny![0],
        };
        for (const violation of violations.map((item) => locateViolation(item, config, locator))) {
          const pointers = Array.isArray(violation.config) ? violation.config : [violation.config];
          assert.deepEqual(pointers.map(pointer => pointer.pointer), expectedPointers[violation.rule], violation.rule);
          for (const pointer of pointers) {
            assert.deepEqual(pointer.value, expectedValues[pointer.pointer], `${violation.rule}: ${pointer.pointer}`);
            assert.match(source[sourceOffset(source, pointer.line, pointer.column)]!, /\S/, violation.rule);
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 30 });
  });

  test("real rule findings keep pointer values and exact entry starts across generated config formatting", () => {
    hegel.test((tc) => {
      const gaps = tc.draw(gs.arrays(whitespace, { minSize: 8, maxSize: 8 }));
      const reverse = tc.draw(gs.booleans());
      const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-pipeline-"));
      try {
        mkdirSync(join(root, "src/a"), { recursive: true });
        mkdirSync(join(root, "src/b"), { recursive: true });
        writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext"}}');
        writeFileSync(join(root, "src/a/index.ts"), 'import { hidden } from "../b/private.js"; export const value = hidden;');
        writeFileSync(join(root, "src/b/index.ts"), "export const visible = 1;");
        writeFileSync(join(root, "src/b/private.ts"), "export const hidden = 2;");
        const modules = [
          { name: "a", glob: "src/a/**", surface: "index.ts" },
          { name: "b", glob: "src/b/**", surface: "index.ts" },
        ];
        const classify = [
          { glob: "src/a/**", tags: ["layer:a"] },
          { glob: "src/b/private.ts", tags: ["layer:secret"] },
          { glob: "src/ghost/**", tags: ["layer:ghost"] },
        ];
        const allowDeny = [
          { source: "layer:a", targetNamespace: "layer", deny: ["secret"], because: "deny secret" },
          { source: "layer:a", targetNamespace: "layer", allow: ["secret"], because: "exhaustive allow" },
        ];
        if (reverse) {
          modules.reverse();
          classify.reverse();
          allowDeny.reverse();
        }
        const raw = {
          because: "test",
          declaredModules: modules,
          exclude: ["archstrict.config.ts"],
          ignoredCycles: [["a", "b"]] as const,
          classify,
          mustBeEmpty: [{ glob: "src/b/private.ts", because: "keep private empty" }],
          deprecated: [{ from: "a", to: "b", count: 0, because: "remove edge" }],
          edges: {
            allowDeny,
            order: [{ tagNamespace: "layer", sequence: { "": ["a", "secret"] },
              direction: "downward-only" as const, because: "layer order" }],
            point: [{ from: "src/a/**", to: "src/b/private.ts", because: "no private edge" }],
          },
        };
        const fields = Object.entries(raw).map(([key, value], index) =>
          `${gaps[index]!}${JSON.stringify(key)}: ${JSON.stringify(value)}`);
        const source = `export default {${fields.join(",")}${gaps.at(-1)!}};\n`;
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(configPath, source);
        const config: Config = { configPath, ...raw };
        const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules!, exclude: config.exclude });
        const locator = createConfigLocator(config);
        const result = runRules(graph, config, { skipTypeLeak: true, configLocator: locator });
        assert.ok(result.violations.length >= 8);
        const targetIndex = reverse ? 0 : 1;
        const denyIndex = reverse ? 1 : 0;
        const allowIndex = reverse ? 0 : 1;
        const ghostIndex = reverse ? 0 : 2;
        const expectedPointers: Record<string, string[]> = {
          "public-surface-bypass": [`declaredModules[${targetIndex}]`],
          "stale-cycle-exception": ["ignoredCycles[0]"],
          "must-be-empty": ["mustBeEmpty[0]"],
          "deprecated-edge-increased": ["deprecated[0].count"],
          "tag-boundary": [`edges.allowDeny[${denyIndex}].deny[0]`, `edges.allowDeny[${denyIndex}].allow`],
          "tag-order": ["edges.order[0].sequence"],
          "point-rule": ["edges.point[0]"],
          "empty-rule-set": [`classify[${ghostIndex}]`],
          "exhaustive-allow-list": [`edges.allowDeny[${allowIndex}].allow`],
        };
        const expectedValues: Record<string, unknown> = {
          [`declaredModules[${targetIndex}]`]: modules[targetIndex],
          "ignoredCycles[0]": ["a", "b"],
          "mustBeEmpty[0]": raw.mustBeEmpty[0],
          "deprecated[0].count": 0,
          [`edges.allowDeny[${denyIndex}].deny[0]`]: "secret",
          [`edges.allowDeny[${denyIndex}].allow`]: null,
          "edges.order[0].sequence": { "": ["a", "secret"] },
          "edges.point[0]": raw.edges.point[0],
          [`classify[${ghostIndex}]`]: classify[ghostIndex],
          [`edges.allowDeny[${allowIndex}].allow`]: ["secret"],
        };
        assert.deepEqual(result.violations.map(violation => violation.rule).sort(), Object.keys(expectedPointers).sort());
        for (const violation of result.violations) {
          const pointers = Array.isArray(violation.config) ? violation.config : [violation.config];
          assert.deepEqual(pointers.map(pointer => pointer.pointer), expectedPointers[violation.rule], violation.rule);
          for (const pointer of pointers) {
            assert.deepEqual(pointer.value, expectedValues[pointer.pointer], `${violation.rule}: ${pointer.pointer}`);
            const offset = sourceOffset(source, pointer.line, pointer.column);
            const expected = pointer.value === null
              ? JSON.stringify((config.edges?.allowDeny ?? []).find((entry) => entry.deny !== undefined))
              : JSON.stringify(pointer.value);
            assert.equal(source.slice(offset, offset + expected.length), expected, `${violation.rule}: ${pointer.pointer}`);
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 10 });
  });
});
