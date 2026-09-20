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

  test("init then check: exit 1 and a next: todo line when a violation exists", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-check-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      let out = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        out = err.stdout;
      }
      expect(exitCode).toBe(1);
      expect(out).toContain("[public-surface-bypass]");
      expect(out.trim().split("\n").at(-1)).toBe("next: archstrict todo");

      let jsonOut = "";
      try {
        jsonOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      const json = JSON.parse(jsonOut);
      expect(json.violations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a config error prints a clean message, not a raw stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-config-error-"));
    try {
      writeFileSync(join(root, "archstrict.config.ts"), "export default { modules: 'src/*' };\n");

      let out = "";
      let errOut = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        exitCode = err.status;
        out = err.stdout;
        errOut = err.stderr;
      }

      expect(exitCode).toBe(1);
      expect(out).toBe("");
      expect(errOut).toContain("missing required field");
      expect(errOut).not.toMatch(/^\s+at /m);
      expect(errOut.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init on a project with no src/ prints a clean message, not a raw stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-init-error-"));
    try {
      let errOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }

      expect(exitCode).toBe(1);
      expect(errOut).toContain("does not exist");
      expect(errOut).not.toMatch(/^\s+at /m);
      expect(errOut.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a config error with --json prints a structured error object", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-config-error-json-"));
    try {
      writeFileSync(join(root, "archstrict.config.ts"), "export default { modules: 'src/*' };\n");

      let out = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        out = err.stdout;
      }

      expect(exitCode).toBe(1);
      const json = JSON.parse(out);
      expect(json.error).toContain("missing required field");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check <nonexistent-file> prints a clean message, not a raw stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-missing-file-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      let errOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "check", "src/app/missing.ts"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }

      expect(exitCode).toBe(1);
      expect(errOut).toContain("no such file");
      expect(errOut).not.toMatch(/^\s+at /m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("todo --json prints a structured TodoResult, on the first run and on a later prune-only run", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-todo-json-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      const first = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(first).toEqual({ firstRun: true, added: 1, pruned: 0 });

      const second = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(second).toEqual({ firstRun: false, added: 0, pruned: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("todo --json on a broken config prints a structured error object, not the text next: line", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-todo-json-error-"));
    try {
      writeFileSync(join(root, "archstrict.config.ts"), "export default { modules: 'src/*' };\n");

      let out = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        out = err.stdout;
      }

      expect(exitCode).toBe(1);
      const json = JSON.parse(out);
      expect(json.error).toContain("missing required field");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
