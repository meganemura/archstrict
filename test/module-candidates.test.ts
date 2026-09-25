// Responsibility: exercise the naming and suggestion functions rule 3,
// `archstrict rules <path>`, and init's re-run all share directly - the
// grouping/naming rules and the exact do: text, independent of any real
// file scan or config load.
import { describe, expect, test } from "vitest";
import {
  groupAnalyzedFiles,
  nameCandidates,
  declaredModuleEntryText,
  suggestUncovered,
  groupForRelFile,
  suggestionDoText,
} from "../src/module-candidates.js";

describe("nameCandidates", () => {
  test("case 1: a group's own on-disk name, with no collision", () => {
    const groups = groupAnalyzedFiles(["src/sqlite.ts"], ["", "src"]);
    const [named] = nameCandidates(groups, new Set());
    expect(named!.entry).toEqual({ name: "sqlite.ts", glob: "src/sqlite.ts", surface: "sqlite.ts" });
  });

  test("case 2: a group below the project root whose on-disk name is already taken falls back to its own project-relative path", () => {
    const groups = groupAnalyzedFiles(["src/cli.ts"], ["", "src"]);
    const [named] = nameCandidates(groups, new Set(["cli.ts"]));
    expect(named!.entry).toEqual({ name: "src/cli.ts", glob: "src/cli.ts", surface: "cli.ts" });
  });

  test("case 3: a project-root group whose on-disk name is still taken (even as its own rel path) gets a './'-prefixed name", () => {
    const groups = groupAnalyzedFiles(["tools/gen.ts"], [""]);
    const [named] = nameCandidates(groups, new Set(["tools"]));
    expect(named!.entry).toEqual({ name: "./tools", glob: "tools/**" });
  });

  test("a directory group carries no surface of its own", () => {
    const groups = groupAnalyzedFiles(["src/extra/a.ts"], ["", "src"]);
    const [named] = nameCandidates(groups, new Set());
    expect(named!.entry).toEqual({ name: "extra", glob: "src/extra/**" });
  });
});

describe("declaredModuleEntryText", () => {
  test("a file entry names itself as its own surface", () => {
    expect(declaredModuleEntryText({ name: "sqlite.ts", glob: "src/sqlite.ts", surface: "sqlite.ts" })).toBe(
      '{ name: "sqlite.ts", glob: "src/sqlite.ts", surface: "sqlite.ts" }',
    );
  });

  test("a directory entry carries no surface field", () => {
    expect(declaredModuleEntryText({ name: "extra", glob: "src/extra/**" })).toBe(
      '{ name: "extra", glob: "src/extra/**" }',
    );
  });
});

describe("suggestUncovered + suggestionDoText (the shared rule-3/rules/init-re-run path)", () => {
  test("a file group's do: carries surface, so following it never makes the module entirely private", () => {
    const declaredModules = [{ name: "build", glob: "src/build/**" }];
    const groups = suggestUncovered(["src/sqlite.ts"], declaredModules);
    const group = groupForRelFile("src/sqlite.ts", groups)!;
    expect(suggestionDoText(group)).toBe(
      'add { name: "sqlite.ts", glob: "src/sqlite.ts", surface: "sqlite.ts" } to declaredModules in archstrict.config.ts, or add "src/sqlite.ts" to exclude if it is not module content; then run archstrict init',
    );
  });

  test("a directory group's do: has no surface field", () => {
    const declaredModules = [{ name: "build", glob: "src/build/**" }];
    const groups = suggestUncovered(["src/extra/a.ts"], declaredModules);
    const group = groupForRelFile("src/extra/a.ts", groups)!;
    expect(suggestionDoText(group)).toBe(
      'add { name: "extra", glob: "src/extra/**" } to declaredModules in archstrict.config.ts, or add "src/extra/**" to exclude if it is not module content; then run archstrict init',
    );
  });

  test("two files in the same uncovered directory share one suggestion", () => {
    const groups = suggestUncovered(["src/extra/a.ts", "src/extra/b.ts"], []);
    const a = groupForRelFile("src/extra/a.ts", groups)!;
    const b = groupForRelFile("src/extra/b.ts", groups)!;
    expect(a.entry).toEqual(b.entry);
    expect(a.fileCount).toBe(2);
  });

  test("a top-level uncovered file whose name an existing entry already uses gets the './' form", () => {
    const declaredModules = [{ name: "tools", glob: "src/tools/**" }];
    const groups = suggestUncovered(["tools/gen.ts"], declaredModules);
    const group = groupForRelFile("tools/gen.ts", groups)!;
    expect(suggestionDoText(group)).toBe(
      'add { name: "./tools", glob: "tools/**" } to declaredModules in archstrict.config.ts, or add "tools/**" to exclude if it is not module content; then run archstrict init',
    );
  });
});
