import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { check } from "../src/verbs/check.js";
import { todo } from "../src/verbs/todo.js";
import { ReportError } from "../src/report-error.js";

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
      await init(root);

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
      await init(root);
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
      await init(root);
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
      await init(root); // declares both app and shared now, while neither bypasses the other
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
      await init(root); // declares only "app" - "shared" doesn't exist yet

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
      // in init.test.ts already covers). archstrict.types.ts's own
      // module-name union now also leaves "shared" out: the union is read
      // back from the untouched config's own declaredModules, not from a
      // fresh discovery walk, so it agrees with what check itself analyzes
      // instead of naming a module check doesn't know about yet. Declaring
      // a genuinely new module means hand-adding its own declaredModules
      // entry - the same real trade-off Prisma's own architecture.config.json
      // makes (a new package there needs its own new config entry too, not
      // automatic discovery).
      const reinitResult = await init(root);
      expect(reinitResult.configWritten).toBe(false);
      expect(reinitResult.moduleNames).toEqual(["app"]);
      expect(readFileSync(reinitResult.generatedPath, "utf8")).toContain('"app"');
      expect(readFileSync(reinitResult.generatedPath, "utf8")).not.toContain("shared");

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
      await init(root); // writes archstrict.types.ts; leaves the hand-written config alone

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
      await init(root);
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
      await init(root);
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

  test("a single-file module whose surface names that file is not a bypass, and todo does not throw", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
      writeFileSync(
        join(root, "src", "app", "index.ts"),
        "import { value } from \"../index.ts\";\nexport const x = value;\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default { declaredModules: [{ name: "src-index", glob: "src/index.ts", surface: "index.ts" }, { name: "app", glob: "src/app/**", surface: "index.ts" }], exclude: ["*.ts"], because: "test" };\n`,
      );

      const before = await check(root);
      expect(before.violations.filter((v) => v.rule === "public-surface-bypass")).toEqual([]);
      expect(before.modulesWithoutSurface).toBe(0);

      const result = await todo(root);
      expect(result).toEqual({ firstRun: true, added: 0, pruned: 0 });
      expect(existsSync(join(root, "src", "index.ts", "archstrict.todo.json"))).toBe(false);
    });
  });

  test("a single-file module with no matching surface freezes its todo beside the file", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "secret.ts"), "export const secret = 1;\n");
      writeFileSync(join(root, "src", "other.ts"), "export const other = 1;\n");
      writeFileSync(
        join(root, "src", "app", "index.ts"),
        "import { secret } from \"../secret.ts\";\nimport { other } from \"../other.ts\";\nexport const x = [secret, other];\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default { declaredModules: [` +
          `{ name: "secret", glob: "src/secret.ts", surface: "index.ts" }, ` +
          `{ name: "other", glob: "src/other.ts", surface: "index.ts" }, ` +
          `{ name: "app", glob: "src/app/**", surface: "index.ts" }` +
          `], exclude: ["*.ts"], because: "test" };\n`,
      );

      const before = await check(root);
      const bypasses = before.violations.filter((v) => v.rule === "public-surface-bypass");
      expect(bypasses).toHaveLength(2);
      for (const violation of bypasses) {
        expect(violation.do).not.toMatch(/to \S+\//);
        expect(violation.do).not.toContain("add a index.ts");
      }
      const secretDo = bypasses.find((v) => v.todoModule === "secret")!.do;
      expect(secretDo).toBe(
        "set surface on 'secret' to match src/secret.ts, or stop importing it; this module is that file, not a directory",
      );

      const result = await todo(root);
      expect(result).toEqual({ firstRun: true, added: 2, pruned: 0 });

      for (const file of ["secret.ts", "other.ts"]) {
        const beside = join(root, "src", `${file}.archstrict.todo.json`);
        expect(JSON.parse(readFileSync(beside, "utf8")).entries).toHaveLength(1);
        expect(existsSync(join(root, "src", file, "archstrict.todo.json"))).toBe(false);
      }

      const after = await check(root);
      expect(after.violations.filter((v) => v.rule === "public-surface-bypass")).toEqual([]);
      expect(after.todo).toBe(2);
    });
  });

  test("a new freeze writes a project-relative, forward-slashed path, not the live violation's absolute one", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      await todo(root);

      const todoFile = join(root, "src", "shared", "archstrict.todo.json");
      const parsed = JSON.parse(readFileSync(todoFile, "utf8")) as { entries: { path: string }[] };
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0]!.path).toBe("src/app/module.ts");
    });
  });

  test("a legacy absolute-path entry that survives pruning is rewritten to relative form (self-healing); one that gets pruned is simply dropped", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      await todo(root); // marks the project as past its first run

      // Hand-write a legacy-shaped entry (absolute path) whose fingerprint
      // still matches the live violation todo(root) above already froze in
      // relative form - simulating a todo file written before this fix.
      const todoFile = join(root, "src", "shared", "archstrict.todo.json");
      const before = JSON.parse(readFileSync(todoFile, "utf8")) as {
        entries: { fingerprint: string; rule: string; path: string; evidence: string }[];
      };
      expect(before.entries).toHaveLength(1);
      // realpathSync(root), not root itself: an old archstrict wrote a
      // live violation's already-realpath'd `.path` verbatim (the same
      // path TypeScript's own program resolved to, e.g. through macOS's
      // /tmp -> /private/tmp), so a faithful legacy fixture must be
      // realpath'd too.
      const legacyPath = join(realpathSync(root), "src", "app", "module.ts");
      writeFileSync(todoFile, JSON.stringify({ entries: [{ ...before.entries[0]!, path: legacyPath }] }, null, 2));

      const result = await todo(root); // prune pass, not first-run
      expect(result.firstRun).toBe(false);
      expect(result.pruned).toBe(0); // the entry still matches - it survives, it isn't dropped

      const after = JSON.parse(readFileSync(todoFile, "utf8")) as { entries: { path: string }[] };
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0]!.path).toBe("src/app/module.ts"); // rewritten from the legacy absolute form
    });
  });

  test("a stale todo entry (hand-edited to no longer match) is its own violation", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
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

  test("first run with an uncovered file refuses: exit via ReportError, exact message and do, no marker, no todo file", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1;\n"); // matches no declared module
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], exclude: ["archstrict.config.ts"], because: "test" };\n`,
      );

      await expect(todo(root)).rejects.toMatchObject({
        message: "todo's first run refuses: 1 file matches no declared module",
        do: "add each to declaredModules or exclude in archstrict.config.ts, then run archstrict todo",
      });
      await expect(todo(root)).rejects.toBeInstanceOf(ReportError);

      expect(existsSync(join(root, ".archstrict-todo-initialized"))).toBe(false);
      expect(existsSync(join(root, "src", "app", "archstrict.todo.json"))).toBe(false);
    });
  });

  test("declaring the previously-uncovered file lets the first run succeed and freeze", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1;\n");
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], exclude: ["archstrict.config.ts"], because: "test" };\n`,
      );

      await expect(todo(root)).rejects.toBeInstanceOf(ReportError);

      // Declare the file that made the first run refuse.
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default { declaredModules: [` +
          `{ name: "app", glob: "src/app/**", surface: "index.ts" }, ` +
          `{ name: "extra", glob: "src/extra.ts", surface: "index.ts" }` +
          `], exclude: ["archstrict.config.ts"], because: "test" };\n`,
      );

      const result = await todo(root);
      expect(result.firstRun).toBe(true);
      expect(existsSync(join(root, ".archstrict-todo-initialized"))).toBe(true);

      const after = await check(root);
      expect(after.violations.some((v) => v.rule === "uncovered-module")).toBe(false);
    });
  });

  test("a later (prune-only) run is unaffected by an uncovered-module violation", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      await todo(root); // past the first run, marker written

      // Introduce a new top-level file that init never declared, so it
      // is uncovered - after the first run, this must not block todo.
      writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1;\n");

      const result = await todo(root);
      expect(result.firstRun).toBe(false);
    });
  });
});
