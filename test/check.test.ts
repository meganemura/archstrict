import { describe, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import ts from "typescript";
import { assertEdgesShapeValid } from "../src/config.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { todo } from "../src/verbs/todo.js";
import { check, formatText, loadConfig } from "../src/verbs/check.js";
import type { Prover } from "../src/rules/config-meaning.js";
import { ReportError } from "../src/report-error.js";
import { buildModuleGraph } from "../src/module-graph.js";

// A real ES module namespace object's own exports are read-only -
// vi.spyOn cannot redefine `ts.createProgram` directly. Every call here
// still runs the real implementation; only the two "check <file>"
// Program tests below actually inspect the spy.
vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof ts }>();
  return { ...actual, default: { ...actual.default,
    createProgram: vi.fn((options: ts.CreateProgramOptions) => actual.default.createProgram(options)) } };
});

function withTempProject(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "archstrict-check-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("loadConfig", () => {
  test.each([{}, { deny: [] }])("rejects an allowDeny entry without a restriction: %j", async (restriction) => {
    await withTempProject(async (root) => {
      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(configPath, `export default ${JSON.stringify({
        declaredModules: [],
        because: "test",
        edges: { allowDeny: [{ source: "kind:app", targetNamespace: "layer", because: "test", ...restriction }] },
      })};`);
      await expect(loadConfig(configPath)).rejects.toThrow(
        "config.edges.allowDeny entry with source 'kind:app' and targetNamespace 'layer' must specify allow or a non-empty deny list",
      );
    });
  });

  test("accepts non-empty allow and deny lists for arbitrary tag values", () => {
    hegel.test((tc) => {
      const values = tc.draw(gen.arrays(gen.text(), { minSize: 1 }));
      for (const restriction of [{ allow: values }, { deny: values }, { allow: [], deny: [] }]) {
        expect(() => assertEdgesShapeValid({
          configPath: "<test>",
          declaredModules: [],
          because: "test",
          edges: { allowDeny: [{ source: "kind:app", targetNamespace: "layer", because: "test", ...restriction }] },
        })).not.toThrow();
      }
    });
  });

  test("loads a real config written by init and adds configPath", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const config = await loadConfig(join(root, "archstrict.config.ts"));
      // A directory entry carries no per-entry surface of its own - the
      // top-level default applies (or a real package.json exports map,
      // when the directory has one).
      expect(config.declaredModules).toEqual([{ name: "app", glob: "src/app/**" }]);
      expect(config.schemaVersion).toBe(1);
      expect(config.configPath).toBe(join(root, "archstrict.config.ts"));
      expect(config.because.length).toBeGreaterThan(0);
    });
  });

  test("a config whose schemaVersion is not 1 throws and names the command to run", async () => {
    await withTempProject(async (root) => {
      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(
        configPath,
        "export default { schemaVersion: 2, declaredModules: [], because: 'test' };\n",
      );
      let thrown: unknown;
      try {
        await loadConfig(configPath);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ReportError);
      expect((thrown as ReportError).message).toContain("schemaVersion");
      expect((thrown as ReportError).do).toContain("schemaVersion to 1");
      expect((thrown as ReportError).do).toContain("archstrict check");
    });
  });

  test("a config missing a required field throws", async () => {
    await withTempProject(async (root) => {
      writeFileSync(join(root, "bad.config.ts"), "export default { modules: 'src/*' };\n");
      await expect(loadConfig(join(root, "bad.config.ts"))).rejects.toThrow(/missing required field/);
    });
  });

  // `declaredModules` satisfying `'declaredModules' in raw` (REQUIRED_FIELDS)
  // is not the same fact as it being a real array of well-shaped entries -
  // `null`, `undefined`, and a non-array value all satisfy `in` and, before
  // this check existed, reached buildModuleGraph/init's own `.map` as a
  // raw TypeError, not a ReportError naming the config and the problem.
  describe.each([
    {
      label: "declaredModules: null",
      declaredModules: "null",
      message: "field 'declaredModules' must be an array, not object",
    },
    {
      label: "declaredModules: undefined",
      declaredModules: "undefined",
      message: "field 'declaredModules' must be an array, not undefined",
    },
    {
      label: "declaredModules is not an array (a string)",
      declaredModules: `"src/**"`,
      message: "field 'declaredModules' must be an array, not string",
    },
    {
      label: "an entry without a name",
      declaredModules: `[{ glob: "src/app/**" }]`,
      message: "field 'declaredModules[0].name' must be a non-empty string, not undefined",
    },
    {
      label: "an entry with an empty-string name",
      declaredModules: `[{ name: "", glob: "src/app/**" }]`,
      message: "field 'declaredModules[0].name' must be a non-empty string, got an empty string",
    },
    {
      label: "an entry with a non-string glob",
      declaredModules: `[{ name: "app", glob: 5 }]`,
      message: "field 'declaredModules[0].glob' must be a string, not number",
    },
  ])("declaredModules shape: $label", ({ declaredModules, message }) => {
    test("loadConfig throws a ReportError naming the config path and the problem, with a do: to run archstrict check", async () => {
      await withTempProject(async (root) => {
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(configPath, `export default { declaredModules: ${declaredModules}, because: "test" };\n`);
        let thrown: unknown;
        try {
          await loadConfig(configPath);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ReportError);
        expect((thrown as ReportError).message).toBe(`${configPath} ${message}`);
        expect((thrown as ReportError).do).toContain(configPath);
        expect((thrown as ReportError).do).toContain("then run archstrict check");
      });
    });

    test("check reports the same ReportError instead of a raw TypeError", async () => {
      await withTempProject(async (root) => {
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(configPath, `export default { declaredModules: ${declaredModules}, because: "test" };\n`);
        let thrown: unknown;
        try {
          await check(root);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ReportError);
        expect((thrown as ReportError).message).toBe(`${configPath} ${message}`);
      });
    });
  });

  test("a config that imports a runtime value (not `import type`) fails with a clear error", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(
        configPath,
        `import { Config } from "./archstrict.types.js";\n` +
          `export default { modules: "src/*", kinds: { flat: "src/*" }, because: "test" } satisfies Config;\n`,
      );
      await expect(loadConfig(configPath)).rejects.toThrow(/may only import types/);
    });
  });

  // Node's ESM loader caches a module by its exact URL; calling loadConfig
  // twice for the same path across a change on disk must not return the
  // first call's stale result (a real bug, fixed once already — this
  // guards against a later "simplification" back to a plain file import).
  test("loadConfig re-reads the file on every call, not the first call's cached module", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const configPath = join(root, "archstrict.config.ts");
      const first = await loadConfig(configPath);
      expect(first.strict).toBeUndefined();

      writeFileSync(
        configPath,
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], strict: ["app"], because: "test" } satisfies Config;\n`,
      );
      const second = await loadConfig(configPath);
      expect(second.strict).toEqual(["app"]);
    });
  });

  test("edges written as an array (not the real {allowDeny?, order?, point?} object) throws, instead of silently configuring nothing", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(
        configPath,
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], edges: [{ rule: "order" }], because: "test" } satisfies Config;\n`,
      );
      await expect(loadConfig(configPath)).rejects.toThrow(/config\.edges must be an object.*not an array/);
    });
  });

  test("an order entry's sequence written as an array (not Record<string, string[]>) throws", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(
        configPath,
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], ` +
          `edges: { order: [{ tagNamespace: "layer", sequence: ["a", "b"], direction: "downward-only", because: "test" }] }, because: "test" } satisfies Config;\n`,
      );
      await expect(loadConfig(configPath)).rejects.toThrow(/sequence must be an object.*not an array/);
    });
  });

  test("an unknown field on an edges entry (a real typo, not a real Config field) throws", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(
        configPath,
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], ` +
          `edges: { order: [{ tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", bogusField: true, because: "test" }] }, because: "test" } satisfies Config;\n`,
      );
      await expect(loadConfig(configPath)).rejects.toThrow(/unknown field 'bogusField'/);
    });
  });

  test("a correctly-shaped edges config still loads and checks exactly as before", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(
        configPath,
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], ` +
          `classify: [{ glob: "src/app/**", tags: ["kind:app"] }], ` +
          `edges: { allowDeny: [{ source: "kind:app", targetNamespace: "kind", allow: [], because: "test" }], ` +
          `order: [{ tagNamespace: "kind", sequence: { "": ["app"] }, direction: "downward-only", because: "test" }] }, ` +
          `because: "test" } satisfies Config;\n`,
      );
      const config = await loadConfig(configPath);
      expect(config.edges?.allowDeny).toHaveLength(1);
      expect(config.edges?.order).toHaveLength(1);
      // Absence is schema 1: a config written before the field existed
      // still loads, and the loader does not invent a value for it.
      expect(config.schemaVersion).toBeUndefined();
    });
  });

  // compileGlob (classify.ts) only special-cases `*` and `**` - every
  // other character a shell or a real glob library treats specially
  // (brace, extglob, `?`, bracket) falls through its own literal branch
  // instead, so a glob written with one of those matches nothing and
  // every file it was meant to cover silently stays uncovered-module.
  // Caught once, here, for every field a glob can appear in - one entry
  // below per field, each varying only the field under test, every other
  // glob-bearing field left a real */** glob so only that one field can
  // be the cause of the thrown error.
  describe("unsupported glob syntax", () => {
    const brace = "src/app/{a,b}/**";
    const UNSUPPORTED_MESSAGE =
      "has an unsupported glob 'src/app/{a,b}/**' - only '*' (any characters within one path segment) and " +
      "'**' (any depth, including zero segments) are supported; '{', '}', '(', ')', '[', ']', '?', and '!' " +
      "all match nothing, including in an extglob form like '+(...)' or '@(...)'";

    const cases = [
      {
        label: "declaredModules[].glob",
        field: "declaredModules[0].glob",
        raw: { declaredModules: [{ name: "app", glob: brace, surface: "index.ts" }], because: "test" },
      },
      {
        label: "declaredModules[].surface",
        field: "declaredModules[0].surface",
        raw: { declaredModules: [{ name: "app", glob: "src/app/**", surface: brace }], because: "test" },
      },
      {
        label: "declaredModules[].friends[].file",
        field: "declaredModules[0].friends[0].file",
        raw: {
          declaredModules: [
            {
              name: "app",
              glob: "src/app/**",
              surface: "index.ts",
              friends: [{ file: brace, from: "src/**", because: "test" }],
            },
          ],
          because: "test",
        },
      },
      {
        label: "declaredModules[].friends[].from",
        field: "declaredModules[0].friends[0].from",
        raw: {
          declaredModules: [
            {
              name: "app",
              glob: "src/app/**",
              surface: "index.ts",
              friends: [{ file: "internal.ts", from: brace, because: "test" }],
            },
          ],
          because: "test",
        },
      },
      {
        label: "exclude[]",
        field: "exclude[0]",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          exclude: [brace],
          because: "test",
        },
      },
      {
        label: "classify[].glob",
        field: "classify[0].glob",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          classify: [{ glob: brace, tags: ["kind:app"] }],
          because: "test",
        },
      },
      {
        label: "mustBeEmpty[].glob",
        field: "mustBeEmpty[0].glob",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          mustBeEmpty: [{ glob: brace, because: "test" }],
          because: "test",
        },
      },
      {
        label: "edges.allowDeny[].exceptions[].from",
        field: "edges.allowDeny[0].exceptions[0].from",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          edges: {
            allowDeny: [
              {
                source: "kind:app",
                targetNamespace: "kind",
                deny: ["other"],
                exceptions: [{ from: brace, to: "src/**", because: "test" }],
                because: "test",
              },
            ],
          },
          because: "test",
        },
      },
      {
        label: "edges.allowDeny[].exceptions[].to",
        field: "edges.allowDeny[0].exceptions[0].to",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          edges: {
            allowDeny: [
              {
                source: "kind:app",
                targetNamespace: "kind",
                deny: ["other"],
                exceptions: [{ from: "src/**", to: brace, because: "test" }],
                because: "test",
              },
            ],
          },
          because: "test",
        },
      },
      {
        label: "edges.point[].from",
        field: "edges.point[0].from",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          edges: { point: [{ from: brace, to: "src/**", because: "test" }] },
          because: "test",
        },
      },
      {
        label: "edges.point[].to",
        field: "edges.point[0].to",
        raw: {
          declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
          edges: { point: [{ from: "src/**", to: brace, because: "test" }] },
          because: "test",
        },
      },
    ];

    test.each(cases)(
      "$label: a brace glob throws naming the field, the glob, and a do: to run archstrict check",
      async ({ field, raw }) => {
        await withTempProject(async (root) => {
          const configPath = join(root, "archstrict.config.ts");
          writeFileSync(configPath, `export default ${JSON.stringify(raw)};\n`);
          let thrown: unknown;
          try {
            await loadConfig(configPath);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(ReportError);
          expect((thrown as ReportError).message).toBe(`${configPath} field '${field}' ${UNSUPPORTED_MESSAGE}`);
          expect((thrown as ReportError).do).toBe(
            `rewrite '${field}' in ${configPath} using only * and **, or split it into one entry per directory, in archstrict.config.ts, then run archstrict check`,
          );
        });
      },
    );

    test("check re-run against an existing config surfaces the same error", async () => {
      await withTempProject(async (root) => {
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(
          configPath,
          `export default ${JSON.stringify({
            declaredModules: [{ name: "app", glob: brace, surface: "index.ts" }],
            because: "test",
          })};\n`,
        );
        await expect(check(root)).rejects.toThrow(/unsupported glob/);
      });
    });

    test("init re-run against an existing config surfaces the same error, with a do: to run archstrict init", async () => {
      await withTempProject(async (root) => {
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(
          configPath,
          `export default ${JSON.stringify({
            declaredModules: [{ name: "app", glob: brace, surface: "index.ts" }],
            because: "test",
          })};\n`,
        );
        let thrown: unknown;
        try {
          await init(root);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ReportError);
        expect((thrown as ReportError).message).toContain("unsupported glob");
        expect((thrown as ReportError).do).toContain("archstrict init");
      });
    });

    test("an extglob glob (+(...)) throws the same way, because '(' alone already catches it", async () => {
      await withTempProject(async (root) => {
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(
          configPath,
          `export default ${JSON.stringify({
            declaredModules: [{ name: "app", glob: "src/app/+(a|b)/**", surface: "index.ts" }],
            because: "test",
          })};\n`,
        );
        await expect(loadConfig(configPath)).rejects.toThrow(
          "field 'declaredModules[0].glob' has an unsupported glob 'src/app/+(a|b)/**'",
        );
      });
    });

    test("a `?` glob throws", async () => {
      await withTempProject(async (root) => {
        const configPath = join(root, "archstrict.config.ts");
        writeFileSync(
          configPath,
          `export default ${JSON.stringify({
            declaredModules: [{ name: "app", glob: "src/app?/**", surface: "index.ts" }],
            because: "test",
          })};\n`,
        );
        await expect(loadConfig(configPath)).rejects.toThrow(
          "field 'declaredModules[0].glob' has an unsupported glob 'src/app?/**'",
        );
      });
    });

    // Control: a config using only the two really-supported wildcards
    // still loads - this check must reject unsupported syntax, not glob
    // syntax in general.
    test("a plain */** glob still loads", async () => {
      await withTempProject(async (root) => {
        mkdirSync(join(root, "src", "app"), { recursive: true });
        writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
        await init(root);
        const config = await loadConfig(join(root, "archstrict.config.ts"));
        expect(config.declaredModules).toEqual([{ name: "app", glob: "src/app/**" }]);
      });
    });
  });
});

describe("check", () => {
  test("init then check on a clean project with the flat preset: every module is uncovered by nothing, but has no public surface", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(
        join(root, "src", "shared", "module.ts"),
        "export const shared = 1;\n",
      );
      writeFileSync(
        join(root, "src", "app", "importer.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      await init(root);

      const result = await check(root);
      expect(result.modules).toBe(2);
      expect(result.edges).toBe(1);
      expect(result.outsideFiles).toBe(0);
      expect(result.unresolvedSpecifiers).toBe(0);
      expect(result.todo).toBe(0);
      // No surface file anywhere: the one cross-module edge (app -> shared)
      // bypasses shared's (nonexistent) public surface.
      expect(result.violations).toHaveLength(1);
      const violation = result.violations[0]!;
      if (violation.rule !== "public-surface-bypass") {
        throw new Error(`expected a public-surface-bypass violation, got ${violation.rule}`);
      }

      const text = formatText(result);
      expect(text).toContain("[public-surface-bypass]");
      expect(text).toContain("because:");
      expect(text.trim().split("\n").at(-1)).toBe("do: archstrict todo");

      // The JSON shape is the contract: pinned against a
      // hand-written expected object, not a snapshot, so a shape change
      // here is a deliberate edit to this test, not an accepted diff.
      expect(Object.keys(violation).sort()).toEqual(
        ["because", "column", "evidence", "line", "do", "path", "rule", "todoModule"].sort(),
      );
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        modules: 2,
        modulesWithoutSurface: 2,
        edges: 1,
        outsideFiles: 0,
        nonTsSourceFiles: 0,
        unresolvedSpecifiers: 0,
        unresolvedSpecifierBreakdown: [],
        unsupportedSyntax: 0,
        typeLeaks: 0,
        todo: 0,
        suggestions: [],
        edgeRuleCoverage: [],
        violations: [
          {
            rule: "public-surface-bypass",
            path: violation.path,
            line: violation.line,
            column: violation.column,
            evidence: violation.evidence,
            because: violation.because,
            do: violation.do,
            todoModule: violation.todoModule,
          },
        ],
      });
    });
  });

  test("a config's top-level surface, not the built-in index.ts default, decides which import bypasses the public surface", async () => {
    await withTempProject(async (unresolvedRoot) => {
      const root = realpathSync(unresolvedRoot);
      mkdirSync(join(root, "src", "a"), { recursive: true });
      mkdirSync(join(root, "src", "b"), { recursive: true });
      writeFileSync(join(root, "src", "b", "main.ts"), "export const value = 1;\n");
      writeFileSync(join(root, "src", "b", "index.ts"), "export const value = 2;\n");
      writeFileSync(
        join(root, "src", "a", "clean.ts"),
        "import { value } from \"../b/main.ts\";\nexport const x = value;\n",
      );
      writeFileSync(
        join(root, "src", "a", "bad.ts"),
        "import { value } from \"../b/index.ts\";\nexport const y = value;\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default ${JSON.stringify({
          declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
          exclude: ["archstrict.config.ts"],
          surface: "main.ts",
          because: "test",
        })};`,
      );

      const result = await check(root);
      expect(result.violations).toHaveLength(1);
      const violation = result.violations[0]!;
      expect(violation.rule).toBe("public-surface-bypass");
      expect(violation.path).toBe(join(root, "src", "a", "bad.ts"));
    });
  });

  test("a project with no violations prints no do: line at all - nothing to re-run, unlike every other do:", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      const result = await check(root);
      expect(result.violations).toHaveLength(0);
      const text = formatText(result);
      expect(text).not.toMatch(/(?:^|\n)\s*do:/);
      expect(text.trim().split("\n").at(-1)).toBe("todo: 0");
    });
  });

  test("the text summary's uncovered-file label matches the violation's own vocabulary, not v0's 'modules glob'", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root); // declares only "app" - "other" doesn't exist yet at init time

      mkdirSync(join(root, "src", "other"), { recursive: true });
      writeFileSync(join(root, "src", "other", "module.ts"), "export const other = 1;\n");

      const result = await check(root);
      expect(result.outsideFiles).toBe(1);
      const text = formatText(result);
      expect(text).toContain("not covered by any declared module: 1");
      expect(text).not.toContain("modules glob");
      // `archstrict todo` could never freeze this violation away (an
      // uncovered file has no module of its own to freeze it into), so
      // the footer names the real fix instead of the usual command.
      expect(text.trim().split("\n").at(-1)).toBe(
        "do: add each uncovered-module file to declaredModules or exclude in archstrict.config.ts, then run archstrict check",
      );
    });
  });

  test("check scans the config's own modules glob, not a hard-coded one", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "lib", "widgets"), { recursive: true });
      writeFileSync(join(root, "lib", "widgets", "module.ts"), "export const widgets = 1;\n");
      await init(root, "lib");

      const result = await check(root);
      expect(result.modules).toBe(1); // found lib/widgets, not src/ (which doesn't exist here)
    });
  });

  test("check <file> reports only that file's own violations", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "a.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      writeFileSync(
        join(root, "src", "app", "b.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const y = shared;\n",
      );
      await init(root);

      const full = await check(root);
      expect(full.violations).toHaveLength(2); // a.ts and b.ts each bypass shared

      const focused = await check(root, join(root, "src", "app", "a.ts"));
      expect(focused.violations).toHaveLength(1);
      // buildModuleGraph now realpaths its own projectRoot up front (a
      // platform's own tmp-directory symlink, e.g. macOS's
      // /var -> /private/var, would otherwise make every reported path
      // disagree with `root` as mkdtempSync returned it) - compare against
      // the same realpath'd form the violation itself now always carries.
      expect(focused.violations[0]!.path).toBe(realpathSync(join(root, "src", "app", "a.ts")));
    });
  });

  // Rule 6 (type-leak)'s own violations are always reported at a surface
  // file's own path (checkTypeLeaks groups every finding under
  // `group.path = surfacePath`) - a `check <file>` scoped to a file that
  // is not any module's own surface can never contain one, so running the
  // rule at all would only build a whole-project ts.Program to throw its
  // answer away.
  test("check <non-surface file> never builds a ts.Program", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "leaky"), { recursive: true });
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(
        join(root, "src", "leaky", "internal.ts"),
        'export interface Hidden { value: string }\nexport function make(): Hidden { return { value: "x" }; }\n',
      );
      writeFileSync(join(root, "src", "leaky", "index.ts"), 'export { make } from "./internal.js";\n');
      writeFileSync(join(root, "src", "app", "a.ts"), "export const a = 1;\n");
      await init(root);

      vi.mocked(ts.createProgram).mockClear();
      const focus = join(root, "src", "app", "a.ts");
      const result = await check(root, focus);
      expect(ts.createProgram).not.toHaveBeenCalled();
      expect(result.violations.some((v) => v.rule === "type-leak")).toBe(false);
      // Pinned: null (not 0) means rule 6 did not run at all this call -
      // "not evaluated" is a different fact than "evaluated, found none".
      expect(result.typeLeaks).toBeNull();
      expect(result.typeLeaksSkippedFile).toBe(focus);
      expect(formatText(result)).toContain(`type leaks: not checked (${focus} is not a module surface file)`);
    });
  });

  test("check <surface file> still builds a ts.Program and reports its own type leak", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "leaky"), { recursive: true });
      writeFileSync(
        join(root, "src", "leaky", "internal.ts"),
        'export interface Hidden { value: string }\nexport function make(): Hidden { return { value: "x" }; }\n',
      );
      writeFileSync(join(root, "src", "leaky", "index.ts"), 'export { make } from "./internal.js";\n');
      await init(root);

      vi.mocked(ts.createProgram).mockClear();
      const result = await check(root, join(root, "src", "leaky", "index.ts"));
      expect(ts.createProgram).toHaveBeenCalled();
      const leak = result.violations.find((v) => v.rule === "type-leak");
      expect(leak).toBeDefined();
      expect(leak!.evidence).toContain("Hidden");
      // Evaluated, found one - a real number, not null.
      expect(result.typeLeaks).toBe(1);
      expect(result.typeLeaksSkippedFile).toBeUndefined();
      expect(formatText(result)).toContain("type leaks: 1");
    });
  });

  test("check <surface file> excludes a file reached only by another surface", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      mkdirSync(join(root, "src", "b"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
      writeFileSync(join(root, "src", "a", "secret.ts"), "export interface Secret { value: string }\n");
      writeFileSync(join(root, "src", "a", "index.ts"), 'import type { Secret } from "./secret.js";\nexport interface Wrap { value: Secret }\n');
      writeFileSync(join(root, "src", "b", "only-b.ts"), "export interface OnlyB { value: number }\n");
      writeFileSync(join(root, "src", "b", "index.ts"), 'export type { OnlyB } from "./only-b.js";\n');
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules: [
          { name: "a", glob: "src/a/**", surface: "index.ts" },
          { name: "b", glob: "src/b/**", surface: "index.ts" },
        ],
        exclude: ["archstrict.config.ts", "tsconfig.json"],
        because: "test architecture",
      })};`);

      vi.mocked(ts.createProgram).mockClear();
      const result = await check(root, join(root, "src", "a", "index.ts"));
      expect(result.typeLeaks).toBe(1);
      const roots = vi.mocked(ts.createProgram).mock.calls.flatMap(([options]) =>
        "rootNames" in options ? options.rootNames : options);
      expect(roots).toContain(realpathSync(join(root, "src", "a", "index.ts")));
      expect(roots).not.toContain(realpathSync(join(root, "src", "b", "only-b.ts")));
    });
  });

  test("check <surface file> falls back with a note for a resolved module augmentation", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      mkdirSync(join(root, "src", "b"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","strict":true,"skipLibCheck":true}}');
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(join(root, "src", "a", "secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src", "a", "index.ts"), 'import type { Secret } from "./secret.js";\nexport interface A { value: Secret }\n');
      writeFileSync(join(root, "src", "b", "index.ts"), "export interface B { value: number }\n");
      writeFileSync(join(root, "src", "b", "augment.ts"), 'export {};\ndeclare module "../a/index.js" { interface A { extra: string } }\n');
      const declaredModules = [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
      ];
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules,
        exclude: ["archstrict.config.ts", "tsconfig.json"], because: "test architecture",
      })};`);

      const reused = buildModuleGraph({ projectRoot: root, declaredModules, exclude: ["archstrict.config.ts", "tsconfig.json"] });
      reused.typeLeaksForFocus("a");
      expect(reused.focusedTypeLeakNotes).toHaveLength(1);
      expect(reused.programNotes).toEqual([]);

      const focus = join(root, "src", "a", "index.ts");
      const full = await check(root);
      const result = await check(root, focus);
      expect(result.notes).toHaveLength(1);
      expect(result.notes![0]).toContain("module augmentation");
      expect(result.notes![0]).toContain("fell back");
      expect(result.typeLeaks).toBe(1);
      expect(result.violations.filter((violation) => violation.rule === "type-leak"))
        .toEqual(full.violations.filter((violation) => violation.rule === "type-leak" && violation.path === realpathSync(focus)));
    });
  });

  test("check <surface file> stays scoped for an external module augmentation", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      mkdirSync(join(root, "src", "b"), { recursive: true });
      mkdirSync(join(root, "node_modules", "external-pkg"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","strict":true,"skipLibCheck":true}}');
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(join(root, "node_modules", "external-pkg", "package.json"), '{"name":"external-pkg","version":"1.0.0","types":"index.d.ts"}');
      writeFileSync(join(root, "node_modules", "external-pkg", "index.d.ts"), "export interface Client { value: number }\n");
      writeFileSync(join(root, "src", "a", "secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src", "a", "index.ts"), 'import type { Secret } from "./secret.js";\nexport interface A { value: Secret }\n');
      writeFileSync(join(root, "src", "b", "index.ts"), "export interface B { value: number }\n");
      writeFileSync(join(root, "src", "b", "only-b.ts"), "export interface OnlyB { value: number }\n");
      writeFileSync(join(root, "src", "b", "augment.ts"), 'export {};\ndeclare module "external-pkg" { interface Client { extra: string } }\n');
      const declaredModules = [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
      ];
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules,
        exclude: ["archstrict.config.ts", "tsconfig.json"], because: "test architecture",
      })};`);

      const focus = join(root, "src", "a", "index.ts");
      const full = await check(root);
      vi.mocked(ts.createProgram).mockClear();
      const result = await check(root, focus);
      expect(result.notes ?? []).toEqual([]);
      expect(result.typeLeaks).toBe(1);
      expect(result.violations.filter((violation) => violation.rule === "type-leak"))
        .toEqual(full.violations.filter((violation) => violation.rule === "type-leak" && violation.path === realpathSync(focus)));
      const roots = vi.mocked(ts.createProgram).mock.calls.flatMap(([options]) =>
        "rootNames" in options ? options.rootNames : options);
      expect(roots).not.toContain(realpathSync(join(root, "src", "b", "only-b.ts")));
    });
  });

  // `applyTodo`'s stale-todo check only evaluates a todo entry whose
  // OWN stored path is the focus file (check.ts's own entryReportedAtFocus
  // comment). Only a file-module's own todo (module.dir IS the file, so
  // stale-todo's own `path: module.dir` can equal `focus`) can ever show
  // stale-todo in a `check <file>` run's own output at all - a directory
  // module's stale-todo always reports at its directory, never a single
  // file, so filterToFile drops it regardless of this change. A cycle's
  // own `path` (the arbitrary edge module-graph.ts's shortest-cycle search
  // happened to return first) can be that file-module's own path when the
  // module is the cycle's own anchor - this fixture forces that: two
  // single-file modules cycling into each other, "a" sorted first so it
  // is always the anchor `checkCycles` picks.
  test("check <file> still reports stale-todo for a file-module's own cycle entry, once the cycle is broken", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), 'import "./b.js";\nexport const a = 1;\n');
      writeFileSync(join(root, "src", "b.ts"), 'import "./a.js";\nexport const b = 1;\n');
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
      writeFileSync(join(root, "archstrict.config.ts"), [
        "export default {",
        '  declaredModules: [{ name: "a", glob: "src/a.ts", surface: "a.ts" }, { name: "b", glob: "src/b.ts", surface: "b.ts" }],',
        '  exclude: ["archstrict.config.ts", "tsconfig.json"],',
        '  because: "test architecture",',
        "};",
      ].join("\n"));
      const aPath = join(root, "src", "a.ts");

      const before = await check(root, aPath);
      const cycle = before.violations.find((v) => v.rule === "cycle");
      expect(cycle).toBeDefined();
      expect(cycle!.path).toBe(realpathSync(aPath)); // the anchor's own file, "a" sorted first
      const frozen = await todo(root);
      expect(frozen.added).toBe(1);

      // Break the cycle - the frozen entry's own violation genuinely no
      // longer exists.
      writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");

      const after = await check(root, aPath);
      expect(after.violations.some((v) => v.rule === "cycle")).toBe(false);
      const stale = after.violations.find((v) => v.rule === "stale-todo");
      expect(stale).toBeDefined();
      expect(stale!.path).toBe(realpathSync(aPath));
      expect(after.todo).toBe(0);
    });
  });

  // Scoping the rules to a directory would drop `stale-todo`, which
  // reports at the module's own directory, never at any one file inside
  // it, since no rule this file scopes reports at a directory.
  // `tryRealpath` therefore returns a value only for a real, existing,
  // REGULAR FILE
  // (`statSync(...).isFile()`); a directory leaves `focus` undefined, so
  // every rule runs its full, unscoped logic and `filterToFile` alone
  // decides what survives - the same as a plain `check` narrowed
  // afterward, and the same as this test's own baseline (`full`) already
  // gets.
  test("check <a module's directory> still reports that module's own stale-todo", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "index.ts"), "export const p = 1;\n");
      writeFileSync(join(root, "src", "shared", "internal.ts"), "export const i = 1;\n");
      writeFileSync(
        join(root, "src", "app", "index.ts"),
        'import { i } from "../shared/internal.js";\nexport const a = i;\n',
      );
      await init(root);

      await todo(root);
      // Fix the bypass - the frozen public-surface-bypass entry (filed
      // under "shared", recorded at the IMPORTER's path, "src/app/index.ts")
      // genuinely no longer matches anything.
      writeFileSync(join(root, "src", "app", "index.ts"), "export const a = 1;\n");

      const full = await check(root);
      expect(full.violations.some((v) => v.rule === "stale-todo")).toBe(true);

      const dirScoped = await check(root, join(root, "src", "shared"));
      expect(dirScoped.violations.some((v) => v.rule === "stale-todo")).toBe(true);
      expect(dirScoped.violations).toEqual(full.violations);
    });
  });

  // A real bug, found while building the PostToolUse hook (which spawns
  // the built CLI as a child process): chdir'ing a process into a
  // directory reached through a symlink makes the OS's own process.cwd()
  // return the resolved, symlink-free path from then on - so a real CLI
  // invocation's own `projectRoot` (process.cwd()) can differ, textually,
  // from `focusFile` (an already-absolute path handed in as plain data,
  // e.g. by Claude Code's own tool_input.file_path) even when both name
  // the exact same file. filterToFile used to compare the two strings
  // as given; this reproduces that mismatch directly with a symlink this
  // test controls, rather than relying on a spawned process or a
  // platform's own tmp-directory quirk (macOS's /tmp -> /private/tmp is
  // one, and is what surfaced this in the first place).
  test("check <file> matches even when the file's path reaches the project through a symlink", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "a.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      await init(root);

      const linkedRoot = join(root, "..", `${root.split("/").at(-1)}-symlink`);
      symlinkSync(root, linkedRoot);
      try {
        const result = await check(root, join(linkedRoot, "src", "app", "a.ts"));
        expect(result.violations).toHaveLength(1);
      } finally {
        rmSync(linkedRoot, { force: true });
      }
    });
  });

  // check()'s own `configPath` (a config-meaning violation's own `path`)
  // is realpath'd once, at the top of check(), for the same reason
  // filterToFile realpaths `file`: a symlinked project root would
  // otherwise leave `config.configPath` in the symlinked textual form
  // while filterToFile's own `target` (from a real, symlinked-through
  // `focusFile`) is realpath'd, comparing unequal and silently dropping
  // every config-meaning finding for a `check <config>` scoped to that
  // project.
  test("check archstrict.config.ts still reports config-meaning through a symlinked project root", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"), [
        "export default {",
        '  declaredModules: [{ name: "app", glob: "src/app/**" }],',
        '  because: "test architecture",',
        "  edges: { point: [{ from: { tags: [\"role:app\"] }, to: \"src/app/**\", because: \"Keep app self-contained.\" }] },",
        "};",
      ].join("\n"));
      const prover: Prover = async () => ({ answers: {
        "point-0": { type: "choice", choice: "contradicts", confidence: 0.9,
          probabilities: { consistent: 0.1, contradicts: 0.9 } },
      } });

      const linkedRoot = join(root, "..", `${root.split("/").at(-1)}-symlink`);
      symlinkSync(root, linkedRoot);
      try {
        const result = await check(linkedRoot, join(linkedRoot, "archstrict.config.ts"), { prove: true, prover });
        expect(result.violations.some((v) => v.rule === "config-meaning")).toBe(true);
      } finally {
        rmSync(linkedRoot, { force: true });
      }
    });
  });

  test("check <nonexistent-file> throws a clear error, not a raw ENOENT", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      await init(root);

      await expect(check(root, join(root, "src", "app", "missing.ts"))).rejects.toThrow(/no such file/);
    });
  });

  test("edgeRuleCoverage reports how many real edges an allowDeny rule actually evaluated", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "index.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/index.ts\";\nexport const x = shared;\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default {\n` +
          `  declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }, { name: "shared", glob: "src/shared/**", surface: "index.ts" }],\n` +
          `  exclude: ["*.ts"],\n` +
          `  classify: [{ glob: "src/app/**", tags: ["kind:app"] }, { glob: "src/shared/**", tags: ["kind:shared"] }],\n` +
          `  edges: { allowDeny: [\n` +
          `    { source: "kind:app", targetNamespace: "kind", allow: ["shared"], because: "test" },\n` +
          `    { source: "kind:app", targetNamespace: "pkg", allow: [], because: "never applies - no external imports here" },\n` +
          `  ] },\n` +
          `  because: "test",\n` +
          `} satisfies Config;\n`,
      );

      const result = await check(root);
      expect(result.edgeRuleCoverage).toEqual([
        { kind: "allowDeny", identifier: "kind:app -> kind", evaluated: 1 },
        { kind: "allowDeny", identifier: "kind:app -> pkg", evaluated: 0 },
      ]);
      // The vacuous second rule surfaces as its own violation too - the
      // coverage field and rule 4 agree about the same real fact.
      expect(result.violations.some((v) => v.rule === "empty-rule-set")).toBe(true);
    });
  });

  test("unresolvedSpecifierBreakdown groups by specifier prefix, most frequent first", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        [
          `import { a } from "@totally-fake-scope/one";`,
          `import { b } from "@totally-fake-scope/one/sub-path";`,
          `import { c } from "another-fake-package";`,
          `export const x = [a, b, c];`,
        ].join("\n"),
      );
      await init(root);

      const result = await check(root);
      // Two distinct subpath specifiers of the same scoped package
      // ("@totally-fake-scope/one" itself, and its own "/sub-path") share
      // that package's own scope+name prefix, so it outranks the single,
      // unrelated "another-fake-package" specifier.
      expect(result.unresolvedSpecifiers).toBe(3);
      expect(result.unresolvedSpecifierBreakdown).toEqual([
        { prefix: "@totally-fake-scope/one", count: 2 },
        { prefix: "another-fake-package", count: 1 },
      ]);

      const text = formatText(result);
      expect(text).toContain("unresolved specifiers: 3");
      expect(text).toContain("top unresolved prefixes: @totally-fake-scope/one (2), another-fake-package (1)");
    });
  });
});


test("a non-object config default export gives the exact load error", () => withTempProject(async root => {
  const configPath = join(root, "archstrict.config.ts");
  writeFileSync(configPath, "export default 5;\n");
  await expect(check(root)).rejects.toEqual(new ReportError(`${configPath} has no default export`, `add a default export satisfying Config to ${configPath}, then run archstrict check`));
}));

test("loadConfig accepts source overrides without reading or changing the disk config", () => withTempProject(async root => {
  const path = join(root, "archstrict.config.ts");
  const original = { declaredModules: [{ name: "disk", glob: "src/disk/**" }], because: "Use the saved boundary." };
  const proposed = { declaredModules: [{ name: "proposal", glob: "src/proposal/**" }], because: "Preview the proposed boundary." };
  writeFileSync(path, `export default ${JSON.stringify(original)};`);
  expect(await loadConfig(path)).toEqual({ ...original, configPath: path });
  expect(await loadConfig(path, `export default ${JSON.stringify(proposed)};`)).toEqual({ ...proposed, configPath: path });
  expect(await loadConfig(path)).toEqual({ ...original, configPath: path });
  const missingPath = join(root, "missing.config.ts");
  expect(await loadConfig(missingPath, `export default ${JSON.stringify(proposed)};`)).toEqual({ ...proposed, configPath: missingPath });
  await expect(loadConfig(path, "")).rejects.toThrow("has no default export");
}));
