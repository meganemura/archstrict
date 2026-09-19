import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { check, formatText, loadConfig } from "../src/verbs/check.js";

function withTempProject(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "archstrict-check-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("loadConfig", () => {
  test("loads a real config written by init and adds configPath", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      init(root);

      const config = await loadConfig(join(root, "archstrict.config.ts"));
      expect(config.modules).toBe("src/*");
      expect(config.kinds).toEqual({ flat: "src/*" });
      expect(config.configPath).toBe(join(root, "archstrict.config.ts"));
      expect(config.because.length).toBeGreaterThan(0);
    });
  });

  test("a config missing a required field throws", async () => {
    await withTempProject(async (root) => {
      writeFileSync(join(root, "bad.config.ts"), "export default { modules: 'src/*' };\n");
      await expect(loadConfig(join(root, "bad.config.ts"))).rejects.toThrow(/missing required field/);
    });
  });
});

describe("check", () => {
  test("init then check on a clean project with the flat preset: every module is uncovered by nothing, but has no public.ts", async () => {
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
      init(root);

      const result = await check(root);
      expect(result.modules).toBe(2);
      expect(result.edges).toBe(1);
      expect(result.outsideFiles).toBe(0);
      expect(result.unresolvedSpecifiers).toBe(0);
      expect(result.todo).toBe(0);
      // No public.ts anywhere: the one cross-module edge (app -> shared)
      // bypasses shared's (nonexistent) public surface.
      expect(result.violations).toHaveLength(1);
      const violation = result.violations[0]!;
      if (violation.rule !== "public-surface-bypass") {
        throw new Error(`expected a public-surface-bypass violation, got ${violation.rule}`);
      }

      const text = formatText(result);
      expect(text).toContain("[public-surface-bypass]");
      expect(text).toContain("because:");
      expect(text.trim().split("\n").at(-1)).toBe("next: archstrict todo");

      // The JSON shape is the contract: pinned against a
      // hand-written expected object, not a snapshot, so a shape change
      // here is a deliberate edit to this test, not an accepted diff.
      expect(Object.keys(violation).sort()).toEqual(
        ["because", "column", "evidence", "line", "next", "path", "rule", "todoModule"].sort(),
      );
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        modules: 2,
        modulesWithoutPublicTs: 2,
        edges: 1,
        outsideFiles: 0,
        unresolvedSpecifiers: 0,
        unsupportedSyntax: 0,
        todo: 0,
        suggestions: [],
        violations: [
          {
            rule: "public-surface-bypass",
            path: violation.path,
            line: violation.line,
            column: violation.column,
            evidence: violation.evidence,
            because: violation.because,
            next: violation.next,
            todoModule: violation.todoModule,
          },
        ],
      });
    });
  });

  test("a project with no violations ends its text output with next: archstrict check", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      init(root);

      const result = await check(root);
      expect(result.violations).toHaveLength(0);
      expect(formatText(result).trim().split("\n").at(-1)).toBe("next: archstrict check");
    });
  });

  test("check scans the config's own modules glob, not a hard-coded one", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "lib", "widgets"), { recursive: true });
      writeFileSync(join(root, "lib", "widgets", "module.ts"), "export const widgets = 1;\n");
      init(root, "lib/*");

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
      init(root);

      const full = await check(root);
      expect(full.violations).toHaveLength(2); // a.ts and b.ts each bypass shared

      const focused = await check(root, join(root, "src", "app", "a.ts"));
      expect(focused.violations).toHaveLength(1);
      expect(focused.violations[0]!.path).toBe(join(root, "src", "app", "a.ts"));
    });
  });
});
