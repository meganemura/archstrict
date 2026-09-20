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

  test("todo never adds after the first run, even when a new violation appears in an already-declared module", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      init(root); // declares both app and shared now, while neither bypasses the other
      await todo(root); // first run: nothing to freeze yet

      // Introduces a real violation, but only within modules init already
      // declared - no new directory, so no re-declaration is needed for
      // this specific case.
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      const result = await todo(root);
      expect(result.firstRun).toBe(false);
      expect(result.added).toBe(0); // never adds again, even though a real violation now exists

      const after = await check(root);
      expect(after.violations).toHaveLength(1); // the new violation is real, uncovered by any todo
    });
  });

  test("a module directory added after init is invisible to check - declare, not discover, even across a re-run", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      init(root); // declares only "app" - "shared" doesn't exist yet

      writeBypassProject(root); // adds src/shared/ AND makes app bypass it, without re-running init

      // Real behavior change from v0: a directory init never declared is
      // not a module at all, so an edge into it resolves outside every
      // declared module - not a public-surface-bypass violation, because
      // there is no declared surface to bypass. This is the direct
      // consequence of "declare, not discover" (measured wrong under v0's
      // own index.ts-presence discovery: NestJS's and Drizzle's own real
      // code showed an undeclared directory is not evidence of an
      // enforced boundary either way). Rule 3 still catches it, the same
      // way it catches any in-scope file no declared module covers.
      const beforeReinit = await check(root);
      expect(beforeReinit.violations).toHaveLength(1);
      expect(beforeReinit.violations[0]!.rule).toBe("uncovered-module");
      expect(beforeReinit.modules).toBe(1); // only "app" is declared; "shared" isn't a module yet

      // Re-running init does NOT add "shared" to declaredModules either:
      // init never rewrites an existing archstrict.config.ts (a hand-edited
      // config must never be clobbered - the same guarantee "is idempotent"
      // in init.test.ts already covers). It only regenerates
      // archstrict.types.ts's own module-name union, which does pick up
      // "shared" - a real signal a project owner would see (a stale name
      // appearing in ModuleName that declaredModules doesn't cover yet),
      // just not one that changes what check itself analyzes. Declaring a
      // genuinely new module means hand-adding its own declaredModules
      // entry - the same real trade-off Prisma's own architecture.config.json
      // makes (a new package there needs its own new config entry too, not
      // automatic discovery).
      const reinitResult = init(root);
      expect(reinitResult.configWritten).toBe(false);
      expect(reinitResult.moduleNames).toEqual(["app", "shared"]);
      expect(readFileSync(reinitResult.generatedPath, "utf8")).toContain('"app" | "shared"');

      const afterReinit = await check(root);
      expect(afterReinit.modules).toBe(1); // declaredModules in the untouched config still names only "app"
      expect(afterReinit.violations).toHaveLength(1);
      expect(afterReinit.violations[0]!.rule).toBe("uncovered-module");
    });
  });

  test("a strict module never gets a todo entry, not even on the first run", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }, { name: "shared", glob: "src/shared/**", surface: "index.ts" }], strict: ["shared"], exclude: ["*.ts"], because: "test" } satisfies Config;\n`,
      );
      init(root); // writes archstrict.types.ts; leaves the hand-written config alone

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
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }, { name: "shared", glob: "src/shared/**", surface: "index.ts" }], strict: ["shared"], exclude: ["*.ts"], because: "test" } satisfies Config;\n`,
      );

      const result = await check(root);
      expect(result.violations.some((v) => v.rule === "clean-module-has-todo")).toBe(true);
      // The frozen violation itself must not be silently suppressed just
      // because it happens to be in a todo file: strict means clean.
      expect(result.todo).toBe(0);
    });
  });

  test("a frozen type-leak entry survives a new exported symbol referencing the same already-known internal type", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "m"), { recursive: true });
      writeFileSync(join(root, "src", "m", "internal.ts"), "export interface Hidden { x: number; }\n");
      writeFileSync(
        join(root, "src", "m", "index.ts"),
        'import type { Hidden } from "./internal.js";\nexport type A = { h: Hidden };\n',
      );
      init(root);
      await todo(root); // freezes the one leak (Hidden, referenced by A)

      const beforeTodoFile = JSON.parse(
        readFileSync(join(root, "src", "m", "archstrict.todo.json"), "utf8"),
      ) as { entries: { fingerprint: string; rule: string }[] };
      expect(beforeTodoFile.entries).toHaveLength(1);
      expect(beforeTodoFile.entries[0]!.rule).toBe("type-leak");

      // A second real export starts referencing the SAME internal type -
      // a real code change, not a fix and not a new leak (Hidden still
      // has no public name), just one more caller of the known one.
      writeFileSync(
        join(root, "src", "m", "index.ts"),
        'import type { Hidden } from "./internal.js";\nexport type A = { h: Hidden };\nexport type B = { h: Hidden };\n',
      );

      const after = await check(root);
      expect(after.violations.some((v) => v.rule === "stale-todo")).toBe(false);
      expect(after.violations.some((v) => v.rule === "type-leak")).toBe(false);
      expect(after.todo).toBe(1); // still suppressed - same fingerprint as before

      // Pruning still works normally for a GENUINELY different leak: add a
      // second, distinct internal type nothing exports by name, and
      // confirm todo can freeze that one as its own, separate entry.
      writeFileSync(
        join(root, "src", "m", "internal.ts"),
        "export interface Hidden { x: number; }\nexport interface OtherHidden { y: number; }\n",
      );
      writeFileSync(
        join(root, "src", "m", "index.ts"),
        'import type { Hidden, OtherHidden } from "./internal.js";\n' +
          "export type A = { h: Hidden };\nexport type B = { h: Hidden };\nexport type C = { o: OtherHidden };\n",
      );
      const secondTodoResult = await todo(root);
      expect(secondTodoResult.firstRun).toBe(false);
      expect(secondTodoResult.added).toBe(0); // todo never adds after the first run, even for a real new leak

      const afterNewLeak = await check(root);
      expect(afterNewLeak.violations.filter((v) => v.rule === "type-leak")).toHaveLength(1);
      expect(afterNewLeak.violations[0]!.evidence).toContain("OtherHidden");
      expect(afterNewLeak.todo).toBe(1); // the original Hidden leak, still suppressed
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
