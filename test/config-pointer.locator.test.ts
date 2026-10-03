// Responsibility: how one config pointer resolves to a value and a source
// position - the wrappers around the exported object, a default export with
// no object literal, values written as expressions or keywords, members and
// spreads that replace a value, multi-digit indices, long list values, and a
// rule's own pointer choice. Boundary: which pointer each rule picks is in
// config-pointer.test.ts, and formatting noise is in the property file. This
// file builds config sources in memory and runs no rule.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Config } from "../src/config.js";
import { createConfigLocator, locateViolation, withPointerSpecs } from "../src/config-pointer.js";
import { loadConfig } from "../src/verbs/check.js";

const configPath = "/project/archstrict.config.ts";

function positionOf(source: string, marker: string): { line: number; column: number } {
  const offset = source.indexOf(marker);
  assert.notEqual(offset, -1, marker);
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") };
}

function resolve(source: string, config: Config, pointer: string): { value: unknown; line: number; column: number } {
  const { value, line, column } = createConfigLocator(config, source).pointer(pointer, "fired");
  return { value, line, column };
}

function deprecatedConfig(count: number): Config { return {
  configPath,
  because: "test",
  declaredModules: [],
  deprecated: [{ from: "a", to: "b", count: count, because: "remove it" }],
}; }

function deprecatedListSource(listText: string, prelude = ""): string {
  return `${prelude}export default {\n  because: "test",\n  declaredModules: [],\n  deprecated: ${listText},\n};\n`;
}

function deprecatedSource(countText: string): string {
  return deprecatedListSource(`[{ from: "a", to: "b", count: ${countText}, because: "remove it" }]`);
}

type ModuleEntry = { name: string; glob: string };

function moduleList(count: number): ModuleEntry[] {
  return Array.from({ length: count }, (_, i) => ({ name: `m${i}`, glob: `src/m${i}/**` }));
}

function moduleListSource(modules: readonly ModuleEntry[], gap = "\n    "): string {
  const entries = modules.map((entry) => `{ name: "${entry.name}", glob: "${entry.glob}" }`);
  return `export default {\n  because: "test",\n  declaredModules: [${gap}${entries.join(`,${gap}`)}${gap}],\n};\n`;
}

function assertListValue(value: unknown, modules: readonly ModuleEntry[]): void {
  if (modules.length <= 20) {
    assert.deepEqual(value, modules);
    return;
  }
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 21);
  assert.deepEqual(value.slice(0, 20), modules.slice(0, 20));
  assert.equal(typeof value[20], "string");
  assert.match(value[20] as string, new RegExp(`\\b${modules.length - 20}\\b`));
}

describe("createConfigLocator export forms", () => {
  test("a config without a source file retains its runtime value at the file start", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-missing-"));
    try {
      const config = { ...deprecatedConfig(3), configPath: join(root, "archstrict.config.ts") };
      assert.deepEqual(createConfigLocator(config).pointer("deprecated[0].count", "fired"), {
        path: config.configPath,
        pointer: "deprecated[0].count",
        value: 3,
        line: 1,
        column: 1,
        role: "fired",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("finds a value through parentheses, as, and satisfies around the exported object or the value", () => {
    const config = deprecatedConfig(3);
    const forms = [
      "{BODY}",
      "({BODY})",
      "{BODY} as Config",
      "{BODY} satisfies Config",
      "{BODY} as const satisfies Config",
      "({BODY} satisfies Config)",
    ];
    for (const form of forms) {
      const body = deprecatedSource("3").replace(/^export default /, "").replace(/;\n$/, "");
      const source = `import type { Config } from "archstrict";\nexport default ${form.replace("{BODY}", body)};\n`;
      assert.deepEqual(resolve(source, config, "deprecated[0].count"), { value: 3, ...positionOf(source, "3, because") }, form);
    }
    for (const countText of ["(3)", "3 as number", "(3 as number)"]) {
      const source = deprecatedSource(countText);
      assert.deepEqual(resolve(source, config, "deprecated[0].count"), { value: 3, ...positionOf(source, "3") }, countText);
    }
  });

  test("a default export with no object literal keeps the value and points at the start of the file", () => {
    const body = deprecatedSource("3").replace(/^export default /, "").replace(/;\n$/, "");
    const source = `const config = ${body};\nexport { config as default };\n`;
    assert.deepEqual(resolve(source, deprecatedConfig(3), "deprecated[0].count"), { value: 3, line: 1, column: 1 });
  });
});

describe("createConfigLocator literal positions", () => {
  test("a value computed by an expression falls back to the nearest enclosing literal", () => {
    const config = deprecatedConfig(3);
    for (const countText of ["LEGACY_IMPORTS", "legacyImports()", "1 + 2"]) {
      const source = `const LEGACY_IMPORTS = 3;\nfunction legacyImports() { return 3; }\n${deprecatedSource(countText)}`;
      assert.deepEqual(resolve(source, config, "deprecated[0].count"), { value: 3, ...positionOf(source, '{ from: "a"') }, countText);
    }
  });

  // loadConfig transpiles source without type checking deprecated counts.
  // These values exercise that runtime boundary, not the Config type.
  test("keyword values accepted by the loader are located at their own keyword", async () => {
    for (const [text, value] of [["true", true], ["false", false], ["null", null]] as const) {
      const source = deprecatedSource(text);
      const config = await loadConfig(configPath, source);
      assert.deepEqual(resolve(source, config, "deprecated[0].count"),
        { value, ...positionOf(source, `${text}, because`) }, text);
    }
  });

  test("a pointer past a list or an entry built by an expression falls back to the nearest enclosing literal", () => {
    const config = deprecatedConfig(3);
    const prelude = 'const LEGACY = { from: "a", to: "b", count: 3, because: "remove it" };\nfunction legacy() { return [LEGACY]; }\n';
    for (const [listText, marker] of [["legacy()", '{\n  because: "test"'], ["[LEGACY]", "[LEGACY],"]] as const) {
      const source = deprecatedListSource(listText, prelude);
      assert.deepEqual(resolve(source, config, "deprecated[0].count"), { value: 3, ...positionOf(source, marker) }, listText);
    }
  });

  // In an object literal, the last member that sets a key decides its
  // runtime value. When that member is a computed key or a shorthand, no
  // literal text holds the value, so the position stops at the containing
  // entry. A computed key before the property cannot replace it.
  test("a later computed key or shorthand that sets the same key moves the position to the containing entry", () => {
    const config = deprecatedConfig(4);
    const prelude = 'const COUNT = "count";\nconst NOTE = "note";\nconst count = 4;\n';
    for (const entryText of [
      '{ from: "a", to: "b", count: 3, [COUNT]: 4, because: "remove it" }',
      '{ from: "a", to: "b", count: 3, count, because: "remove it" }',
    ]) {
      const source = deprecatedListSource(`[${entryText}]`, prelude);
      assert.deepEqual(resolve(source, config, "deprecated[0].count"), { value: 4, ...positionOf(source, entryText) }, entryText);
    }
    const source = deprecatedListSource('[{ [NOTE]: "kept", from: "a", to: "b", count: 4, because: "remove it" }]', prelude);
    assert.deepEqual(resolve(source, config, "deprecated[0].count"), { value: 4, ...positionOf(source, "4, because") });
  });
});

describe("createConfigLocator indices and list values", () => {
  test("a two-digit index resolves to its own entry's value and position", () => {
    const modules = moduleList(12);
    const source = moduleListSource(modules);
    const config: Config = { configPath, because: "test", declaredModules: modules };
    assert.deepEqual(resolve(source, config, "declaredModules[11]"), { value: modules[11], ...positionOf(source, '{ name: "m11"') });
    assert.deepEqual(resolve(source, config, "declaredModules[10]"), { value: modules[10], ...positionOf(source, '{ name: "m10"') });
  });

  test("a list value stays whole up to twenty entries and is cut after that, naming how many entries it leaves out", () => {
    for (const count of [20, 21, 45]) {
      const modules = moduleList(count);
      const config: Config = { configPath, because: "test", declaredModules: modules };
      assertListValue(resolve(moduleListSource(modules), config, "declaredModules").value, modules);
    }
  });

  test("every index into a generated module list resolves to its entry, and the list value matches the twenty-entry cut", () => {
    const whitespace = gs.sampledFrom([" ", "\n    ", "\n    /* entry */ "]);
    hegel.test((tc) => {
      const modules = moduleList(tc.draw(gs.integers({ minValue: 0, maxValue: 30 })));
      const source = moduleListSource(modules, tc.draw(whitespace));
      const config: Config = { configPath, because: "test", declaredModules: modules };
      const locator = createConfigLocator(config, source);
      modules.forEach((entry, index) => {
        const { value, line, column } = locator.pointer(`declaredModules[${index}]`, "governs");
        assert.deepEqual({ value, line, column }, { value: entry, ...positionOf(source, `{ name: "${entry.name}"`) });
      });
      assertListValue(locator.pointer("declaredModules", "governs").value, modules);
    }, { testCases: 30 });
  });

  // A spread adds entries that the source text does not show. A source index
  // names the same runtime entry only while no spread comes at or before it.
  // From the spread on, the position is the list itself.
  test("in a list with one spread, an index before the spread resolves to its entry and every later index to the list", () => {
    const shared = [{ name: "shared-x", glob: "src/x/**" }, { name: "shared-y", glob: "src/y/**" }];
    hegel.test((tc) => {
      const length = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const spreadAt = tc.draw(gs.integers({ minValue: 0, maxValue: length - 1 }));
      const written = moduleList(length);
      const elements = written.map((entry, index) =>
        index === spreadAt ? "...shared" : `{ name: "${entry.name}", glob: "${entry.glob}" }`);
      const source = `const shared = ${JSON.stringify(shared)};\n` +
        `export default {\n  because: "test",\n  declaredModules: [${elements.join(", ")}],\n};\n`;
      const runtime = [...written.slice(0, spreadAt), ...shared, ...written.slice(spreadAt + 1)];
      const config: Config = { configPath, because: "test", declaredModules: runtime };
      const locator = createConfigLocator(config, source);
      const list = positionOf(source, `[${elements[0]!}`);
      runtime.forEach((entry, index) => {
        const { value, line, column } = locator.pointer(`declaredModules[${index}]`, "governs");
        const expected = index < spreadAt ? positionOf(source, `{ name: "${entry.name}"`) : list;
        assert.deepEqual({ value, line, column }, { value: entry, ...expected }, `spread at ${spreadAt}, index ${index}`);
      });
    }, { testCases: 30 });
  });
});

describe("locateViolation pointer specs", () => {
  test("a rule's own pointer specs replace the fallback, so duplicate entries get separate locations", () => {
    const source = [
      "export default {",
      '  because: "test",',
      "  declaredModules: [],",
      "  mustBeEmpty: [",
      '    { glob: "src/legacy/**", because: "frozen" },',
      '    { glob: "src/legacy/**", because: "frozen again" },',
      "  ],",
      "};",
      "",
    ].join("\n");
    const config: Config = {
      configPath,
      because: "test",
      declaredModules: [],
      mustBeEmpty: [{ glob: "src/legacy/**", because: "frozen" }, { glob: "src/legacy/**", because: "frozen again" }],
    };
    const locator = createConfigLocator(config, source);
    const located = [0, 1].map((index) => {
      const violation = withPointerSpecs({
        rule: "must-be-empty",
        path: "/project/src/legacy/x.ts",
        line: 1,
        column: 1,
        evidence: "'src/legacy/x.ts' matches 'src/legacy/**', which must stay empty",
        because: "frozen",
        do: "move src/legacy/x.ts out of src/legacy",
      }, [{ pointer: `mustBeEmpty[${index}]`, role: "fired" }]);
      const result = locateViolation(violation, config, locator);
      const pointers = Array.isArray(result.config) ? result.config : [result.config];
      assert.equal(pointers.length, 1);
      return { pointer: pointers[0]!.pointer, line: pointers[0]!.line, column: pointers[0]!.column };
    });
    assert.deepEqual(located, [
      { pointer: "mustBeEmpty[0]", ...positionOf(source, '{ glob: "src/legacy/**", because: "frozen" }') },
      { pointer: "mustBeEmpty[1]", ...positionOf(source, '{ glob: "src/legacy/**", because: "frozen again" }') },
    ]);
  });
});
