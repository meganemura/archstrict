// Responsibility: verify that an ignore file above the project root still
// applies on a platform whose path separator is a backslash. node:path is
// replaced so that `sep` is "\\" and `relative` answers with backslashes, as
// it does on Windows. Every other path function and the file system stay real.
// Boundary: only the separator in the path from an ignore file's directory to
// the project root. The pattern language belongs to gitignore-pattern.test.ts,
// and the project walk belongs to gitignore.test.ts.
import { describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPathGitignored } from "../src/gitignore.js";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  const relative = (from: string, to: string) => actual.relative(from, to).split("/").join("\\");
  return { ...actual, sep: "\\", relative, default: { ...actual, sep: "\\", relative } };
});

describe("gitignore with a backslash path separator", () => {
  // The project root sits two directories below the repository root, so the
  // path between them holds a separator, and the rule is anchored, so it can
  // match only through that path.
  test("an anchored rule in the repository root's .gitignore reaches a nested project root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-gitignore-separator-")));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".gitignore"), "packages/web/tmp/\n");
      const web = join(root, "packages", "web");
      mkdirSync(web, { recursive: true });
      expect(isPathGitignored(web, "tmp/scratch.ts", new Set())).toBe(true);
      expect(isPathGitignored(web, "src/index.ts", new Set())).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
