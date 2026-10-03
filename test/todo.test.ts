import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { check } from "../src/verbs/check.js";

import { readTodoFile } from "../src/todo-store.js";
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

function writeSurfaceProject(unresolvedRoot: string): string {
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
  return root;
}

describe("todo", () => {
  test("first run names multiple uncovered files and leaves freezing available", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1;\n");
      writeFileSync(join(root, "src", "other.ts"), "export const other = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"),
        'export default { declaredModules: [{ name: "app", glob: "src/app/**" }], exclude: ["archstrict.config.ts"], because: "test" };\n');
      await expect(todo(root)).rejects.toMatchObject({
        message: "todo's first run refuses: 2 files match no declared module",
        do: "add each to declaredModules or exclude in archstrict.config.ts, then run archstrict todo",
      });
      expect(existsSync(join(root, "archstrict.todo.json"))).toBe(false);
    });
  });

  test("an existing root todo file takes precedence over leftover legacy files", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      expect(await todo(root)).toEqual({ firstRun: true, added: 1, pruned: 0 });
      const rootTodo = readFileSync(join(root, "archstrict.todo.json"), "utf8");
      const legacyFile = join(root, "src", "shared", "archstrict.todo.json");
      writeFileSync(legacyFile, "unfinished legacy JSON");
      writeFileSync(join(root, ".archstrict-todo-initialized"), "");
      expect(await todo(root)).toEqual({ firstRun: false, added: 0, pruned: 0 });
      expect(readFileSync(join(root, "archstrict.todo.json"), "utf8")).toBe(rootTodo);
      expect(readFileSync(legacyFile, "utf8")).toBe("unfinished legacy JSON");
      expect(existsSync(join(root, ".archstrict-todo-initialized"))).toBe(true);
    });
  });

  test("pruning counts every entry under a module that the current graph no longer declares", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      expect(await todo(root)).toEqual({ firstRun: true, added: 1, pruned: 0 });
      const saved = readTodoFile(root)!;
      const entries = saved.modules.get("shared")!;
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({
        schemaVersion: 1,
        modules: { shared: entries, retired: [entries[0], entries[0]] },
      }));
      expect(await todo(root)).toEqual({ firstRun: false, added: 0, pruned: 2 });
      expect([...readTodoFile(root)!.modules.keys()]).toEqual(["shared"]);
      expect(readTodoFile(root)!.modules.get("shared")).toEqual(entries);
    });
  });

  test("pruning retains an existing imported edge and leaves a new imported edge unfrozen", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      expect(await todo(root)).toEqual({ firstRun: true, added: 1, pruned: 0 });
      writeFileSync(join(root, "src", "shared", "other.ts"), "export const other = 2;\n");
      writeFileSync(join(root, "src", "app", "module.ts"),
        'import { shared } from "../shared/module.ts";\nimport { other } from "../shared/other.ts";\nexport const x = shared + other;\n');
      expect(await todo(root)).toEqual({ firstRun: false, added: 0, pruned: 0 });
      const entries = readTodoFile(root)!.modules.get("shared")!;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        rule: "public-surface-bypass", path: "src/app/module.ts",
        specifier: "../shared/module.ts", target: "src/shared/module.ts",
      });
      const after = await check(root);
      expect(after.todo).toBe(1);
      expect(after.violations).toHaveLength(1);
      expect(after.violations[0]).toMatchObject({
        rule: "public-surface-bypass", specifier: "../shared/other.ts",
        target: join(realpathSync(root), "src", "shared", "other.ts"),
      });
    });
  });

  test("the freeze note counts bypasses and excludes other freezable rules", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      const imports: string[] = [];
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(root, "src", "shared", `file${i}.ts`), `export const value${i} = ${i};\n`);
        imports.push(`import { value${i} } from "../shared/file${i}.ts";`);
      }
      writeFileSync(join(root, "src", "app", "module.ts"),
        `${imports.join("\n")}\nexport const values = [value0, value1, value2, value3, value4, value5, value6, value7];\n`);
      const config = {
        declaredModules: [{ name: "app", glob: "src/app/**" }, { name: "shared", glob: "src/shared/**" }],
        exclude: ["archstrict.config.ts"],
        classify: [
          { glob: "src/app/**", tags: ["domain:app"] },
          { glob: "src/shared/file0.ts", tags: ["domain:shared"] },
        ],
        edges: { allowDeny: [{ source: "domain:app", targetNamespace: "domain", allow: [], because: "app cannot reach shared" }] },
        because: "test",
      };
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify(config)};\n`);
      const before = await check(root);
      expect(before.violations.filter(v => v.rule === "public-surface-bypass")).toHaveLength(8);
      expect(before.violations.filter(v => v.rule === "tag-boundary")).toHaveLength(1);
      expect(await todo(root)).toEqual({
        firstRun: true, added: 9, pruned: 0,
        notes: ["8 of 8 public-surface-bypass violations target 'shared', which holds 8 of 9 analyzed files. Freezing them records one bucket. Split 'shared' into directories that change together before treating this freeze as done."],
      });
      const saved = readTodoFile(root)!;
      expect(saved.modules.get("shared")).toHaveLength(8);
      expect(saved.modules.get("app")).toHaveLength(1);
      expect(saved.modules.get("app")![0]!.rule).toBe("tag-boundary");
    });
  });

  test("a config's top-level surface freezes the same bypass check reports", async () => {
    await withTempProject(async (unresolvedRoot) => {
      const root = writeSurfaceProject(unresolvedRoot);

      const before = await check(root);
      expect(before.violations).toHaveLength(1);
      expect(before.violations[0]!.rule).toBe("public-surface-bypass");
      expect(before.violations[0]!.path).toBe(join(root, "src", "a", "bad.ts"));

      const result = await todo(root);
      expect(result.firstRun).toBe(true);
      expect(result.added).toBe(1);
      expect(result.pruned).toBe(0);

      const after = await check(root);
      expect(after.violations).toHaveLength(0);
      expect(after.todo).toBe(1);
    });
  });

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

  test("todo entries live in one project-root archstrict.todo.json, grouped by module name", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      await todo(root);

      const todoFile = join(root, "archstrict.todo.json");
      const parsed = JSON.parse(readFileSync(todoFile, "utf8"));
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.modules.shared).toHaveLength(1);
      expect(parsed.modules.shared[0].rule).toBe("public-surface-bypass");
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
      const clean = result.violations.find((v) => v.rule === "clean-module-has-todo");
      expect(clean).toBeDefined();
      // Points at the "shared" module's own key inside the "modules"
      // object, not line 1 - the same real position stale-todo's own
      // entries use.
      expect(clean!.path).toBe(join(realpathSync(root), "archstrict.todo.json"));
      const todoText = readFileSync(join(root, "archstrict.todo.json"), "utf8");
      const sharedKeyLine = todoText.split("\n").findIndex((l) => l.trim().startsWith('"shared"')) + 1;
      expect(clean!.line).toBe(sharedKeyLine);
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
        readFileSync(join(root, "archstrict.todo.json"), "utf8"),
      ) as { modules: Record<string, { rule: string }[]> };
      expect(beforeTodoFile.modules.m!).toHaveLength(1);
      expect(beforeTodoFile.modules.m![0]!.rule).toBe("type-leak");

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
      // The file is always written after the first run, even with nothing
      // to freeze, so its own existence keeps meaning "todo has run".
      expect(JSON.parse(readFileSync(join(root, "archstrict.todo.json"), "utf8")).modules).toEqual({});
      expect(existsSync(join(root, "src", "index.ts.archstrict.todo.json"))).toBe(false);
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

      const todoFile = JSON.parse(readFileSync(join(root, "archstrict.todo.json"), "utf8"));
      expect(todoFile.modules.secret).toHaveLength(1);
      expect(todoFile.modules.other).toHaveLength(1);
      expect(existsSync(join(root, "src", "secret.ts.archstrict.todo.json"))).toBe(false);
      expect(existsSync(join(root, "src", "other.ts.archstrict.todo.json"))).toBe(false);

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

      const todoFile = join(root, "archstrict.todo.json");
      const parsed = JSON.parse(readFileSync(todoFile, "utf8")) as { modules: Record<string, { path: string }[]> };
      expect(parsed.modules.shared!).toHaveLength(1);
      expect(parsed.modules.shared![0]!.path).toBe("src/app/module.ts");
    });
  });

  test("an absolute-path entry that survives pruning is rewritten to relative form (self-healing); one that gets pruned is simply dropped", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      await todo(root); // marks the project as past its first run

      // Hand-write the entry back with an absolute path - simulating a
      // todo file whose entry was never relativized (or a hand edit).
      const todoFile = join(root, "archstrict.todo.json");
      const before = JSON.parse(readFileSync(todoFile, "utf8")) as {
        modules: Record<string, { rule: string; path: string; evidence: string }[]>;
      };
      expect(before.modules.shared!).toHaveLength(1);
      // realpathSync(root), not root itself: a live violation's own `path`
      // is already realpath'd (the same path TypeScript's own program
      // resolved to, e.g. through macOS's /tmp -> /private/tmp), so a
      // faithful absolute fixture must be realpath'd too.
      const absolutePath = join(realpathSync(root), "src", "app", "module.ts");
      writeFileSync(todoFile, JSON.stringify({
        schemaVersion: 1,
        modules: { shared: [{ ...before.modules.shared![0]!, path: absolutePath }] },
      }, null, 2));

      const result = await todo(root); // prune pass, not first-run
      expect(result.firstRun).toBe(false);
      expect(result.pruned).toBe(0); // the entry still matches - it survives, it isn't dropped

      const after = JSON.parse(readFileSync(todoFile, "utf8")) as { modules: Record<string, { path: string }[]> };
      expect(after.modules.shared!).toHaveLength(1);
      expect(after.modules.shared![0]!.path).toBe("src/app/module.ts"); // rewritten from the absolute form
    });
  });

  test("a stale todo entry (hand-edited to no longer match) is its own violation, at the entry's own line", async () => {
    await withTempProject(async (root) => {
      writeBypassProject(root);
      await init(root);
      await todo(root);

      // Hand-edit the todo to name a rule/path/evidence nothing produces -
      // written with JSON.stringify's own pretty-printer (NOT
      // serializeTodoFile's one-entry-per-line layout), so this also
      // proves stale-todo's own line comes from parsing the real file,
      // not from re-deriving a position against archstrict's own
      // canonical serialization.
      const todoFile = join(root, "archstrict.todo.json");
      const text = JSON.stringify(
        { schemaVersion: 1, modules: { shared: [{ rule: "public-surface-bypass", path: "x", evidence: "y" }] } },
        null,
        2,
      );
      writeFileSync(todoFile, text);
      // The entry object's own opening brace sits one line above its
      // first property - JSON.stringify's pretty printer always puts a
      // nested object's own "{" on its own line.
      const ruleLineIndex = text.split("\n").findIndex((l) => l.includes('"rule": "public-surface-bypass"'));
      const expectedLine = ruleLineIndex; // 0-based index of that line IS the 1-based line number of the "{" above it

      const result = await check(root);
      const stale = result.violations.find((v) => v.rule === "stale-todo");
      expect(stale).toBeDefined();
      expect(stale!.path).toBe(join(realpathSync(root), "archstrict.todo.json"));
      expect(stale!.line).toBe(expectedLine);
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

      expect(existsSync(join(root, "archstrict.todo.json"))).toBe(false);
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
      expect(existsSync(join(root, "archstrict.todo.json"))).toBe(true);

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

  // The bug this covers: freezing three bypasses into a surface-less
  // module, then giving that module a surface, used to reword every OTHER
  // bypass's own evidence too ("has no index.ts" -> "other than its
  // a.ts") - a frozen entry's stored fingerprint was hashed from that old
  // sentence, so it stopped matching the reworded violation and read as
  // an active, unfreezable violation, even though the edge it names never
  // moved. An agent moving a module to a surface file by file could never
  // finish without every earlier step un-freezing everyone else's debt.
  test("giving a module a surface reworks the OTHER frozen bypasses' evidence without un-freezing them", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "src", "shared", "b.ts"), "export const b = 1;\n");
      writeFileSync(join(root, "src", "shared", "c.ts"), "export const c = 1;\n");
      writeFileSync(join(root, "src", "app", "usesA.ts"), 'import { a } from "../shared/a.js";\nexport const x = a;\n');
      writeFileSync(join(root, "src", "app", "usesB.ts"), 'import { b } from "../shared/b.js";\nexport const y = b;\n');
      writeFileSync(join(root, "src", "app", "usesC.ts"), 'import { c } from "../shared/c.js";\nexport const z = c;\n');
      const configPath = join(root, "archstrict.config.ts");
      const configWithSurface = (surface: string | undefined) => `export default ${JSON.stringify({
        declaredModules: [
          { name: "shared", glob: "src/shared/**", ...(surface !== undefined ? { surface } : {}) },
          { name: "app", glob: "src/app/**", surface: "index.ts" },
        ],
        exclude: ["archstrict.config.ts"],
        because: "test",
      })};`;
      writeFileSync(configPath, configWithSurface(undefined));

      const before = await check(root);
      const bypasses = before.violations.filter((v) => v.rule === "public-surface-bypass");
      expect(bypasses).toHaveLength(3);
      expect(bypasses.every((v) => v.evidence.includes("which has no"))).toBe(true);

      const frozen = await todo(root);
      expect(frozen.added).toBe(3);
      expect((await check(root)).violations).toHaveLength(0);

      // Give the module a surface naming one of the three internal files -
      // the other two importers now read a reworded sentence ("other than
      // its a.ts" instead of "which has no ...").
      writeFileSync(configPath, configWithSurface("a.ts"));
      const afterSurface = await check(root);
      const stillBypassing = afterSurface.violations.filter((v) => v.rule === "public-surface-bypass");
      expect(stillBypassing).toHaveLength(0); // b and c: still frozen, not reported as active bypasses
      // a's own frozen entry now matches nothing at all (a is no longer a
      // violation, since it resolved to the module's own new surface) -
      // that entry is correctly flagged stale (only `archstrict todo`
      // itself prunes it), not silently kept forever.
      expect(afterSurface.violations.filter((v) => v.rule === "stale-todo")).toHaveLength(1);
      expect(afterSurface.todo).toBe(2); // b and c still suppressed; a is no longer a violation at all

      // Confirm the evidence really did change (the bug this test guards
      // against never fires if the sentence stayed the same) - the frozen
      // entry's own stored evidence is still the OLD wording, since todo
      // only ever prunes or freezes, never rewrites a surviving entry.
      const todoFile = JSON.parse(readFileSync(join(root, "archstrict.todo.json"), "utf8"));
      expect(todoFile.modules.shared).toHaveLength(3); // not yet pruned - todo never adds, but also never auto-prunes on check
      const bEntry = todoFile.modules.shared.find((e: { path: string }) => e.path.endsWith("usesB.ts"));
      expect(bEntry.evidence).toContain("which has no"); // frozen at the OLD wording; still matches the reworded live violation

      // A later, prune-only run removes exactly the one entry (a) that
      // stopped being a violation at all - b and c stay frozen.
      const pruneResult = await todo(root);
      expect(pruneResult.firstRun).toBe(false);
      expect(pruneResult.pruned).toBe(1);
      const prunedFile = JSON.parse(readFileSync(join(root, "archstrict.todo.json"), "utf8"));
      expect(prunedFile.modules.shared).toHaveLength(2);
      expect((await check(root)).violations).toHaveLength(0);
    });
  });

  // Same family of bug as the surface one above, for rule 7's tag-order:
  // its own evidence embeds the FULL configured sequence purely to explain
  // the direction, not to name the edge. Adding a value to that sequence
  // that this edge never touches must not un-freeze an already-frozen
  // tag-order entry.
  test("a frozen tag-order entry survives an unrelated value added to its own sequence", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "ui"), { recursive: true });
      writeFileSync(join(root, "src", "core", "a.ts"), 'import { b } from "../ui/b.js";\nexport const a = b;\n');
      writeFileSync(join(root, "src", "ui", "b.ts"), "export const b = 1;\n");
      const configPath = join(root, "archstrict.config.ts");
      const configWithSequence = (sequence: string[]) => `export default ${JSON.stringify({
        declaredModules: [{ name: "all", glob: "src/**", surface: "index.ts" }],
        classifyByDirectoryName: { tagNamespace: "layer", names: ["core", "ui", "mid"] },
        edges: { order: [{ tagNamespace: "layer", sequence: { "": sequence }, because: "core stays innermost" }] },
        exclude: ["archstrict.config.ts"],
        because: "test",
      })};`;
      writeFileSync(configPath, configWithSequence(["core", "ui"]));

      const before = await check(root);
      const orderViolations = before.violations.filter((v) => v.rule === "tag-order");
      expect(orderViolations).toHaveLength(1);
      expect(orderViolations[0]!.evidence).toContain("core -> ui");

      const frozen = await todo(root);
      expect(frozen.added).toBe(1);
      expect((await check(root)).violations).toHaveLength(0);

      // Insert an unrelated value into the SAME sequence - the edge's own
      // two layers (core, ui) are unaffected, but evidence's own displayed
      // sequence now reads differently.
      writeFileSync(configPath, configWithSequence(["core", "mid", "ui"]));
      const afterInsert = await check(root);
      expect(afterInsert.violations.filter((v) => v.rule === "tag-order")).toHaveLength(0);
      expect(afterInsert.violations.some((v) => v.rule === "stale-todo")).toBe(false);
      expect(afterInsert.todo).toBe(1);
    });
  });

  // A later prune-only run rewrites a legacy public-surface-bypass entry
  // (frozen before specifier/target existed) to the current format the
  // moment it's confirmed to still match - self-healing, the same as
  // readTodo already does for a legacy absolute `path`. A later run then
  // matches it by the primary fingerprint lookup alone, with no evidence
  // parse at all.
  test("a prune-only run upgrades a legacy bypass entry it still matches to the current, specifier/target format", async () => {
    await withTempProject(async (unresolvedRoot) => {
      const root = writeSurfaceProject(unresolvedRoot);
      await todo(root); // freezes in the current format
      const todoFile = join(root, "archstrict.todo.json");
      const frozen = JSON.parse(readFileSync(todoFile, "utf8"));
      expect(frozen.modules.b).toHaveLength(1);
      expect(frozen.modules.b[0].specifier).toBeDefined();

      // Roll that one entry back to the legacy, pre-migration shape: no
      // specifier/target at all.
      const legacy = {
        rule: frozen.modules.b[0].rule,
        path: frozen.modules.b[0].path,
        evidence: frozen.modules.b[0].evidence,
      };
      writeFileSync(todoFile, JSON.stringify({ schemaVersion: 1, modules: { b: [legacy] } }, null, 2));

      const result = await todo(root);
      expect(result.firstRun).toBe(false);
      expect(result.pruned).toBe(0); // still matches - not dropped

      const upgraded = JSON.parse(readFileSync(todoFile, "utf8"));
      expect(upgraded.modules.b).toHaveLength(1);
      expect(upgraded.modules.b[0].specifier).toBeDefined();
      expect(upgraded.modules.b[0].target).toBeDefined();

      expect((await check(root)).violations).toHaveLength(0);
    });
  });

  // The regression this covers: a real project's todo file predates this
  // ticket's own fix. Its stored `fingerprint` is a hash of
  // rule+ABSOLUTE-path+evidence (todo.ts's freeze step, before this fix,
  // hashed the live violation before ever relativizing anything for
  // storage) - type-leak's own formula changed (path is now excluded), so
  // that stored hash can never again equal today's recompute, even though
  // the entry's own stored `evidence` is byte-identical to the live
  // violation's. `check` alone (no `todo` run in between) must still read
  // it as matching, with zero stale-todo findings.
  test("check reports zero stale-todo for a type-leak entry frozen with the pre-fix (path-including) formula", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "m"), { recursive: true });
      writeFileSync(join(root, "src", "m", "internal.ts"), "export type Secret = { x: number };\n");
      writeFileSync(
        join(root, "src", "m", "public.ts"),
        'import type { Secret } from "./internal.js";\nexport function get(): Secret { return { x: 1 }; }\n',
      );
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules: [{ name: "m", glob: "src/m/**", surface: "public.ts" }],
        exclude: ["archstrict.config.ts"],
        because: "test",
      })};`);

      const before = await check(root);
      const leak = before.violations.find((v) => v.rule === "type-leak");
      expect(leak).toBeDefined();

      const preFixFingerprint = createHash("sha256")
        .update(`type-leak\n${leak!.path}\n${leak!.evidence}`)
        .digest("hex").slice(0, 12);
      writeFileSync(
        join(root, "src", "m", "archstrict.todo.json"),
        JSON.stringify({
          entries: [{ fingerprint: preFixFingerprint, rule: "type-leak", path: "src/m/public.ts", evidence: leak!.evidence }],
        }, null, 2),
      );

      const after = await check(root);
      expect(after.violations).toHaveLength(0);
      expect(after.todo).toBe(1);
    });
  });

  test("check reports zero stale-todo for a tag-order entry frozen with the pre-fix (full-sequence-evidence) formula", async () => {
    await withTempProject(async (root) => {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "ui"), { recursive: true });
      writeFileSync(join(root, "src", "core", "a.ts"), 'import { b } from "../ui/b.js";\nexport const a = b;\n');
      writeFileSync(join(root, "src", "ui", "b.ts"), "export const b = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules: [{ name: "all", glob: "src/**", surface: "index.ts" }],
        classifyByDirectoryName: { tagNamespace: "layer", names: ["core", "ui"] },
        edges: { order: [{ tagNamespace: "layer", sequence: { "": ["core", "ui"] }, because: "core stays innermost" }] },
        exclude: ["archstrict.config.ts"],
        because: "test",
      })};`);

      const before = await check(root);
      const violation = before.violations.find((v) => v.rule === "tag-order");
      expect(violation).toBeDefined();

      const preFixFingerprint = createHash("sha256")
        .update(`tag-order\n${violation!.path}\n${violation!.evidence}`)
        .digest("hex").slice(0, 12);
      writeFileSync(
        join(root, "src", "archstrict.todo.json"),
        JSON.stringify({
          entries: [{ fingerprint: preFixFingerprint, rule: "tag-order", path: "src/core/a.ts", evidence: violation!.evidence }],
        }, null, 2),
      );

      const after = await check(root);
      expect(after.violations).toHaveLength(0);
      expect(after.todo).toBe(1);
    });
  });
});
