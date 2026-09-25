import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { assertEdgesShapeValid } from "../src/config.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { check, formatText, loadConfig } from "../src/verbs/check.js";
import { ReportError } from "../src/report-error.js";

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
      expect(config.declaredModules).toEqual([{ name: "app", glob: "src/app/**", surface: "index.ts" }]);
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
    });
  });

  test("check scans the config's own modules glob, not a hard-coded one", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "lib", "widgets"), { recursive: true });
      writeFileSync(join(root, "lib", "widgets", "module.ts"), "export const widgets = 1;\n");
      await init(root, "lib/*");

      const result = await check(root);
      expect(result.modules).toBe(1); // found lib/widgets, not src/* (which doesn't exist here)
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
