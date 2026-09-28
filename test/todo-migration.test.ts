import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteLegacyTodoFiles, LEGACY_MARKER_NAME, readLegacyTodoState } from "../src/todo-migration.js";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-todo-migration-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("readLegacyTodoState", () => {
  test("reads a directory module's own archstrict.todo.json, stripping the old fingerprint field", () => {
    withRoot((root) => {
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(
        join(root, "src", "shared", "archstrict.todo.json"),
        JSON.stringify({
          entries: [{ fingerprint: "abc123abc123", rule: "public-surface-bypass", path: "src/app/module.ts", evidence: "e" }],
        }),
      );
      const state = readLegacyTodoState(root, new Map([["shared", join(root, "src", "shared")]]));
      expect(state.present).toBe(true);
      expect(state.entriesByModule.get("shared")).toEqual([
        { rule: "public-surface-bypass", path: "src/app/module.ts", evidence: "e" },
      ]);
      expect(state.filesToDelete).toEqual([join(root, "src", "shared", "archstrict.todo.json")]);
    });
  });

  test("reads a single-file module's todo beside the file, keyed by the module's own name", () => {
    withRoot((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
      writeFileSync(
        join(root, "src", "index.ts.archstrict.todo.json"),
        JSON.stringify({ entries: [{ rule: "type-leak", path: "src/index.ts", evidence: "e" }] }),
      );
      const state = readLegacyTodoState(root, new Map([["src-index", join(root, "src", "index.ts")]]));
      expect(state.entriesByModule.get("src-index")).toEqual([
        { rule: "type-leak", path: "src/index.ts", evidence: "e" },
      ]);
      expect(state.filesToDelete).toEqual([join(root, "src", "index.ts.archstrict.todo.json")]);
    });
  });

  test("normalizes a legacy absolute path/target into project-relative form", () => {
    withRoot((root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      const importer = join(root, "src", "app", "module.ts");
      const target = join(root, "src", "shared", "internal.ts");
      writeFileSync(
        join(root, "src", "shared", "archstrict.todo.json"),
        JSON.stringify({
          entries: [{
            rule: "public-surface-bypass", path: importer, evidence: "e",
            specifier: "../shared/internal.js", target,
          }],
        }),
      );
      const state = readLegacyTodoState(root, new Map([["shared", join(root, "src", "shared")]]));
      expect(state.entriesByModule.get("shared")).toEqual([{
        rule: "public-surface-bypass", path: "src/app/module.ts", evidence: "e",
        specifier: "../shared/internal.js", target: "src/shared/internal.ts",
      }]);
    });
  });

  test("the marker alone (no per-module files) still reads as present, with no entries", () => {
    withRoot((root) => {
      writeFileSync(join(root, LEGACY_MARKER_NAME), "");
      const state = readLegacyTodoState(root, new Map([["app", join(root, "src", "app")]]));
      expect(state.present).toBe(true);
      expect(state.entriesByModule.size).toBe(0);
      expect(state.filesToDelete).toEqual([join(root, LEGACY_MARKER_NAME)]);
    });
  });

  test("no marker and no per-module file reads as not present at all", () => {
    withRoot((root) => {
      const state = readLegacyTodoState(root, new Map([["app", join(root, "src", "app")]]));
      expect(state.present).toBe(false);
      expect(state.filesToDelete).toEqual([]);
    });
  });

  // A module whose own glob covers the project root itself (e.g. "**")
  // has its legacy per-module path equal to the new single file's own
  // path (both are join(projectRoot, "archstrict.todo.json")). That path
  // must be read (it holds real legacy entries) but never queued for
  // deletion: freezeOrPrune overwrites it in place with the migrated,
  // schema-versioned content, and deleting it afterward would erase that
  // migration, not an old file left behind by it.
  test("a root-directory module's legacy file collides with the new file's own path - read, but excluded from deletion", () => {
    withRoot((root) => {
      writeFileSync(
        join(root, "archstrict.todo.json"),
        JSON.stringify({ entries: [{ rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" }] }),
      );
      const state = readLegacyTodoState(root, new Map([["all", root]]));
      expect(state.present).toBe(true);
      expect(state.entriesByModule.get("all")).toEqual([{ rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" }]);
      expect(state.filesToDelete).toEqual([]);
    });
  });
});

describe("deleteLegacyTodoFiles", () => {
  test("removes every file named, and tolerates one already gone", () => {
    withRoot((root) => {
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      const p = join(root, "src", "shared", "archstrict.todo.json");
      writeFileSync(p, "{}");
      const marker = join(root, LEGACY_MARKER_NAME);
      // marker deliberately not written - deleteLegacyTodoFiles must not
      // throw on a path that doesn't exist.
      deleteLegacyTodoFiles([p, marker]);
      expect(existsSync(p)).toBe(false);
    });
  });
});

// Builds the project, then hand-writes both legacy todo files from the
// REAL live violations `check` reports on the fresh project - not
// hand-typed evidence text, which would silently drift from whatever
// rules/public-surface.ts's own wording actually is. Returns the two live
// violations so a test can assert against them directly instead of
// guessing what a matching entry looks like.
async function writeMigrationFixture(root: string): Promise<{ sharedBypass: { path: string; evidence: string; specifier?: string; target?: string }; secretBypass: { path: string; evidence: string; specifier?: string; target?: string } }> {
  mkdirSync(join(root, "src", "app"), { recursive: true });
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  writeFileSync(join(root, "src", "shared", "index.ts"), "export const publicValue = 1;\n");
  writeFileSync(join(root, "src", "shared", "internal.ts"), "export const internalValue = 1;\n");
  writeFileSync(join(root, "src", "secret.ts"), "export const secretValue = 1;\n");
  writeFileSync(
    join(root, "src", "app", "index.ts"),
    'import { internalValue } from "../shared/internal.js";\n' +
      'import { secretValue } from "../secret.js";\n' +
      "export const x = internalValue + secretValue;\n",
  );
  writeFileSync(
    join(root, "archstrict.config.ts"),
    `export default { declaredModules: [` +
      `{ name: "app", glob: "src/app/**", surface: "index.ts" }, ` +
      `{ name: "shared", glob: "src/shared/**", surface: "index.ts" }, ` +
      `{ name: "secret", glob: "src/secret.ts", surface: "index.ts" }` +
      `], exclude: ["archstrict.config.ts"], because: "test" };\n`,
  );

  const { check } = await import("../src/verbs/check.js");
  const live = await check(root);
  const bypasses = live.violations.filter((v) => v.rule === "public-surface-bypass") as {
    path: string; evidence: string; specifier?: string; target?: string; todoModule?: string;
  }[];
  const sharedBypass = bypasses.find((v) => v.todoModule === "shared")!;
  const secretBypass = bypasses.find((v) => v.todoModule === "secret")!;
  // realpathSync(root), not root itself: a violation's own `path`/`target`
  // is already realpath'd (module-graph.ts's own prepareGraph), so on a
  // machine where the temp dir is reached through a symlink (macOS's own
  // /tmp -> /private/tmp), root itself would never be a prefix of it.
  const rootReal = realpathSync(root);
  const relative = (p: string) => p.slice(rootReal.length + 1);

  // Legacy state: a directory module's own frozen bypass, a single-file
  // module's own frozen bypass (beside the file, since it has no
  // directory of its own), and the marker - as if an older archstrict ran
  // here before the single-file layout existed.
  writeFileSync(
    join(root, "src", "shared", "archstrict.todo.json"),
    JSON.stringify({
      entries: [{
        fingerprint: "abc123abc123", rule: "public-surface-bypass",
        path: relative(sharedBypass.path), evidence: sharedBypass.evidence,
        specifier: sharedBypass.specifier, target: relative(sharedBypass.target!),
      }],
    }),
  );
  writeFileSync(
    join(root, "src", "secret.ts.archstrict.todo.json"),
    JSON.stringify({
      entries: [{
        fingerprint: "def456def456", rule: "public-surface-bypass",
        path: relative(secretBypass.path), evidence: secretBypass.evidence,
        specifier: secretBypass.specifier, target: relative(secretBypass.target!),
      }],
    }),
  );
  writeFileSync(join(root, LEGACY_MARKER_NAME), "");
  return { sharedBypass, secretBypass };
}

describe("check reads the old layout before migration", () => {
  test("a plain check suppresses the legacy-frozen bypass and names the migration in its notes", async () => {
    const { check } = await import("../src/verbs/check.js");
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-migration-check-"));
    try {
      await writeMigrationFixture(root);

      const result = await check(root);
      expect(result.violations.filter((v) => v.rule === "public-surface-bypass")).toEqual([]);
      expect(result.todo).toBe(2); // both legacy bypass entries, still suppressed
      expect(result.notes ?? []).toContain(
        "reading frozen debt from the old per-module todo layout - run archstrict todo to migrate it into one archstrict.todo.json",
      );

      // Reading never migrates anything on its own - only `archstrict todo`
      // writes the new file and deletes the old ones.
      expect(existsSync(join(root, "archstrict.todo.json"))).toBe(false);
      expect(existsSync(join(root, "src", "shared", "archstrict.todo.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("check migrates the old layout on the first archstrict todo run", () => {
  test("todo folds every legacy file (directory module, single-file module, marker) into one file, then deletes the old ones - same violations and todo count before and after", async () => {
    const { todo } = await import("../src/verbs/todo.js");
    const { check } = await import("../src/verbs/check.js");
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-migration-e2e-"));
    try {
      await writeMigrationFixture(root);

      const before = await check(root);

      const result = await todo(root);
      expect(result.firstRun).toBe(false); // a migration, not a genuinely first run
      expect(result.pruned).toBe(0); // both legacy entries still match their live violations

      expect(existsSync(join(root, "src", "shared", "archstrict.todo.json"))).toBe(false);
      expect(existsSync(join(root, "src", "secret.ts.archstrict.todo.json"))).toBe(false);
      expect(existsSync(join(root, LEGACY_MARKER_NAME))).toBe(false);
      const migrated = JSON.parse(readFileSync(join(root, "archstrict.todo.json"), "utf8"));
      expect(migrated.modules.shared).toHaveLength(1);
      expect(migrated.modules.secret).toHaveLength(1);

      const after = await check(root);
      expect(after.violations).toEqual(before.violations);
      expect(after.todo).toBe(before.todo);
      expect(after.notes ?? []).toEqual([]); // the migration note is gone - nothing legacy is left to read
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
