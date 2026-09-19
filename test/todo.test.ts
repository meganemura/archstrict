import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { check } from "../src/verbs/check.js";
import { todo } from "../src/verbs/todo.js";

function withTempProject(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "archstrict-todo-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function writeBypassProject(root: string): void {
  mkdirSync(join(root, "src", "app"), { recursive: true });
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
  writeFileSync(
    join(root, "src", "app", "module.ts"),
    "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
  );
}

describe("todo", () => {
  test("first run freezes the current violation; check on the same input is then green", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      init(root);

      const before = await check(root);
      expect(before.violations).toHaveLength(1);

      const result = await todo(root);
      expect(result.firstRun).toBe(true);
      expect(result.added).toBe(1);
      expect(result.pruned).toBe(0);

      // The round trip the spec names: todo then check on unchanged input
      // is always green.
      const after = await check(root);
      expect(after.violations).toHaveLength(0);
      expect(after.todo).toBe(1);
    });
  });

  test("todo file lives inside the exposed module's own directory", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      init(root);
      await todo(root);

      const todoFile = join(root, "src", "shared", "archstrict.todo.json");
      const parsed = JSON.parse(readFileSync(todoFile, "utf8"));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].rule).toBe("public-surface-bypass");
    });
  });

  test("a second run only prunes: fixing the violation removes the todo file, not by adding", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      init(root);
      await todo(root);

      // Fix the violation by removing the bypassing import.
      writeFileSync(join(root, "src", "app", "module.ts"), "export const x = 1;\n");

      const result = await todo(root);
      expect(result.firstRun).toBe(false);
      expect(result.added).toBe(0);
      expect(result.pruned).toBe(1);

      const after = await check(root);
      expect(after.violations).toHaveLength(0);
      expect(after.todo).toBe(0);
    });
  });

  test("todo never adds after the first run, even when a new violation appears", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      init(root);
      await todo(root); // first run: nothing to freeze yet

      writeBypassProject(root); // introduces a new violation
      const result = await todo(root);
      expect(result.firstRun).toBe(false);
      expect(result.added).toBe(0); // never adds again, even though a real violation now exists

      const after = await check(root);
      expect(after.violations).toHaveLength(1); // the new violation is real, uncovered by any todo
    });
  });

  test("a strict module never gets a todo entry, not even on the first run", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.generated.js";\n` +
          `export default { modules: "src/*", kinds: { flat: "src/*" }, strict: ["shared"], because: "test" } satisfies Config;\n`,
      );
      init(root); // writes archstrict.generated.ts; leaves the hand-written config alone

      const result = await todo(root);
      expect(result.added).toBe(0);

      const after = await check(root);
      expect(after.violations).toHaveLength(1); // strict module's violation is never hidden
      expect(after.todo).toBe(0);
    });
  });

  test("a strict module's own existing todo entries are a violation, not silently kept", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      init(root);
      await todo(root); // freezes the violation while shared is not yet strict

      // Mark shared strict after the fact - it already has a frozen entry.
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.generated.js";\n` +
          `export default { modules: "src/*", kinds: { flat: "src/*" }, strict: ["shared"], because: "test" } satisfies Config;\n`,
      );

      const result = await check(root);
      expect(result.violations.some((v) => v.rule === "clean-module-has-todo")).toBe(true);
      // The frozen violation itself must not be silently suppressed just
      // because it happens to be in a todo file: strict means clean.
      expect(result.todo).toBe(0);
    });
  });

  test("a stale todo entry (hand-edited to no longer match) is its own violation", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      init(root);
      await todo(root);

      // Hand-edit the todo to name a fingerprint nothing produces.
      const todoFile = join(root, "src", "shared", "archstrict.todo.json");
      writeFileSync(
        todoFile,
        JSON.stringify(
          { entries: [{ fingerprint: "000000000000", rule: "public-surface-bypass", path: "x", evidence: "y" }] },
          null,
          2,
        ),
      );

      const result = await check(root);
      expect(result.violations.some((v) => v.rule === "stale-todo")).toBe(true);
    });
  });
});
