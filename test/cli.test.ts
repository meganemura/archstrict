import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;

// Built, not run from src/ directly: this project's internal imports use
// nodenext's .js-extension convention (matching nukadoko's, depug's, and
// solarsql's own source, and their bin fields all point at dist/ for the
// same reason). Node's native TypeScript type-stripping strips syntax but
// does not remap a ".js" specifier to a sibling ".ts" file the way a
// bundler or vitest's own resolver does, so running src/cli.ts as a
// separate node process (as this file's tests do) needs the real .js
// files a build produces. Measured: `node src/cli.ts init` failed with
// ERR_MODULE_NOT_FOUND for "./verbs/init.js" before this fix.
beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT });
});

describe("cli", () => {
  test("prints usage with no arguments", () => {
    expect(() => execFileSync("node", [CLI_PATH], { encoding: "utf8" })).toThrow();
  });

  test("init writes the two files and prints a next: line", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-init-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");

      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("next: archstrict check");
      expect(readFileSync(join(root, "archstrict.generated.ts"), "utf8")).toContain('"app"');
      expect(readFileSync(join(root, "archstrict.config.ts"), "utf8")).toContain("satisfies Config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
