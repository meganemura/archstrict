import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK_PATH = join(REPO_ROOT, ".agents", "hooks", "pre-tool-use.mjs");
const DIST_CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

// Mirrors post-tool-use.test.ts's own reasoning: node's native TypeScript
// stripping doesn't remap a .js-extension specifier to a sibling .ts file
// across a spawned process, so the hook (like the CLI itself) has to run
// against a real build, not src/cli.ts directly, for the integration test.

type FakeBehavior = "clean" | "added" | "added-with-resolved" | "error" | "timeout";

// A real, installed project's node_modules/.bin/archstrict is a shim npm
// itself creates - here a small node script standing in for `archstrict
// simulate --json`. It records the stdin it received to `stdinMarkerPath`
// so a test can assert the hook built the proposed file text correctly,
// not merely that it invoked the binary at all.
function installFakeArchstrict(projectRoot: string, behavior: FakeBehavior): void {
  const binDir = join(projectRoot, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(stdinMarkerPath(projectRoot))}, input);
  const behavior = ${JSON.stringify(behavior)};
  const violation = {
    rule: "public-surface-bypass", path: "/tmp/x.ts", line: 1, column: 1,
    evidence: "resolved to shared's internal module.ts", because: "shared's index.ts does not export module",
    config: { path: "/tmp/archstrict.config.ts", pointer: "/declaredModules/0", value: "shared", line: 2, column: 3, role: "declaredModules[0]" },
    do: "export module from shared/index.ts, or import from shared/index.ts instead",
  };
  if (behavior === "timeout") {
    setTimeout(() => { process.stdout.write("too late"); process.exit(0); }, 3000);
    return;
  }
  if (behavior === "error") {
    process.stdout.write(JSON.stringify({ error: "archstrict.config.ts is missing required field 'because'", do: "add 'because' to archstrict.config.ts" }));
    process.exit(1);
  }
  if (behavior === "added") {
    process.stdout.write(JSON.stringify({ mode: "scoped", added: [violation], resolved: [], unchangedCount: 0 }));
    process.exit(1);
  }
  if (behavior === "added-with-resolved") {
    process.stdout.write(JSON.stringify({ mode: "scoped", added: [violation], resolved: [{ ...violation, path: "/tmp/y.ts" }], unchangedCount: 0 }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ mode: "scoped", added: [], resolved: [], unchangedCount: 0 }));
  process.exit(0);
});
`;
  const binPath = join(binDir, "archstrict");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
}

function stdinMarkerPath(projectRoot: string): string {
  return join(projectRoot, ".archstrict-stdin.json");
}

// Same shape post-tool-use.test.ts uses for the real, built CLI.
function installRealArchstrictBin(projectRoot: string): void {
  const binDir = join(projectRoot, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "archstrict");
  writeFileSync(binPath, `#!/bin/sh\nexec node "${DIST_CLI_PATH}" "$@"\n`);
  chmodSync(binPath, 0o755);
}

function withTempProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-pretooluse-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runHook(input: unknown, env: Record<string, string> = {}): {
  hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
} {
  const stdout = execFileSync("node", [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout);
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("pre-tool-use hook", () => {
  test("Write: builds the proposed content from tool_input.content and reports added violations", () => {
    withTempProject((root) => {
      installFakeArchstrict(root, "added");
      const filePath = join(root, "src", "app", "new.ts");
      const output = runHook({ tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root });

      expect(JSON.parse(readFileSync(stdinMarkerPath(root), "utf8"))).toEqual({
        changes: [{ path: filePath, content: "export const x = 1;\n" }],
      });
      expect(output.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
      expect(output.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(output.hookSpecificOutput?.additionalContext).toContain("public-surface-bypass");
      expect(output.hookSpecificOutput?.additionalContext).toContain("because:");
      expect(output.hookSpecificOutput?.additionalContext).toContain("config:");
      expect(output.hookSpecificOutput?.additionalContext).toContain("do:");
      // The Write call must never actually happen - PreToolUse only previews it.
      expect(existsSync(filePath)).toBe(false);
    });
  });

  test("Edit: applies old_string -> new_string to the file's current text", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      const filePath = join(root, "src", "existing.ts");
      writeFileSync(filePath, "export const before = 1;\n");
      installFakeArchstrict(root, "clean");

      const output = runHook({
        tool_name: "Edit",
        tool_input: { file_path: filePath, old_string: "before", new_string: "after" },
        cwd: root,
      });

      expect(JSON.parse(readFileSync(stdinMarkerPath(root), "utf8"))).toEqual({
        changes: [{ path: filePath, content: "export const after = 1;\n" }],
      });
      expect(output.hookSpecificOutput).toBeUndefined();
      // The file on disk is untouched - only the fake binary saw the proposed text.
      expect(readFileSync(filePath, "utf8")).toBe("export const before = 1;\n");
    });
  });

  test("Edit with replace_all: replaces every occurrence before simulating", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      const filePath = join(root, "src", "existing.ts");
      writeFileSync(filePath, "const a = shared; const b = shared;\n");
      installFakeArchstrict(root, "clean");

      runHook({
        tool_name: "Edit",
        tool_input: { file_path: filePath, old_string: "shared", new_string: "local", replace_all: true },
        cwd: root,
      });

      expect(JSON.parse(readFileSync(stdinMarkerPath(root), "utf8"))).toEqual({
        changes: [{ path: filePath, content: "const a = local; const b = local;\n" }],
      });
    });
  });

  test("MultiEdit: applies every edit in order", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      const filePath = join(root, "src", "existing.ts");
      writeFileSync(filePath, "export const one = 1;\nexport const two = 2;\n");
      installFakeArchstrict(root, "clean");

      runHook({
        tool_name: "MultiEdit",
        tool_input: {
          file_path: filePath,
          edits: [
            { old_string: "one = 1", new_string: "one = 100" },
            { old_string: "two = 2", new_string: "two = 200" },
          ],
        },
        cwd: root,
      });

      expect(JSON.parse(readFileSync(stdinMarkerPath(root), "utf8"))).toEqual({
        changes: [{ path: filePath, content: "export const one = 100;\nexport const two = 200;\n" }],
      });
    });
  });

  test("a missing old_string stays silent and never invokes archstrict", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      const filePath = join(root, "src", "existing.ts");
      writeFileSync(filePath, "export const before = 1;\n");
      installFakeArchstrict(root, "added");

      const output = runHook({
        tool_name: "Edit",
        tool_input: { file_path: filePath, old_string: "does not exist", new_string: "after" },
        cwd: root,
      });

      expect(output.hookSpecificOutput).toBeUndefined();
      expect(existsSync(stdinMarkerPath(root))).toBe(false);
    });
  });

  test("a timeout stays silent", () => {
    withTempProject((root) => {
      const filePath = join(root, "src", "new.ts");
      installFakeArchstrict(root, "timeout");

      const output = runHook(
        { tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root },
        { ARCHSTRICT_PRETOOLUSE_TIMEOUT_MS: "100" },
      );

      expect(output.hookSpecificOutput).toBeUndefined();
    });
  }, 10_000);

  test("says nothing when the project has no archstrict installed", () => {
    withTempProject((root) => {
      const filePath = join(root, "src", "new.ts");
      const output = runHook({ tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  test("a config or input error from simulate stays silent", () => {
    withTempProject((root) => {
      installFakeArchstrict(root, "error");
      const filePath = join(root, "src", "new.ts");
      const output = runHook({ tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  test("no added violations stays silent, even when the change resolves one", () => {
    withTempProject((root) => {
      installFakeArchstrict(root, "clean");
      const filePath = join(root, "src", "new.ts");
      const output = runHook({ tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  test("added violations are reported as allow with additionalContext, and a resolved count is mentioned", () => {
    withTempProject((root) => {
      installFakeArchstrict(root, "added-with-resolved");
      const filePath = join(root, "src", "new.ts");
      const output = runHook({ tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root });

      expect(output.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(output.hookSpecificOutput?.additionalContext).toContain("would add 1 violation");
      expect(output.hookSpecificOutput?.additionalContext).toContain("would also resolve 1 violation");
    });
  });

  test("ARCHSTRICT_PRETOOLUSE=deny denies the tool call with the same text as the reason", () => {
    withTempProject((root) => {
      installFakeArchstrict(root, "added");
      const filePath = join(root, "src", "new.ts");
      const output = runHook(
        { tool_name: "Write", tool_input: { file_path: filePath, content: "export const x = 1;\n" }, cwd: root },
        { ARCHSTRICT_PRETOOLUSE: "deny" },
      );

      expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("public-surface-bypass");
      expect(output.hookSpecificOutput?.additionalContext).toBeUndefined();
    });
  });

  test("ignores a tool that isn't an edit, and a non-.ts file", () => {
    const bashOutput = runHook({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: process.cwd() });
    expect(bashOutput.hookSpecificOutput).toBeUndefined();

    withTempProject((root) => {
      const jsonFile = join(root, "notes.json");
      const output = runHook({ tool_name: "Write", tool_input: { file_path: jsonFile, content: "{}" }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  test("malformed stdin (not JSON) emits an empty result, never throws", () => {
    const stdout = execFileSync("node", [HOOK_PATH], { input: "not json", encoding: "utf8" });
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("integration: a real violation is previewed against the real built CLI before the write happens", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      const importer = join(root, "src", "app", "importer.ts");
      writeFileSync(importer, "export const x = 1;\n");
      writeFileSync(
        join(root, "archstrict.types.ts"),
        "export type ModuleName = \"app\" | \"shared\";\nexport type Config = { surface?: string; declaredModules: readonly { name: string; glob: string; surface: string }[]; because: string };\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        "import type { Config } from \"./archstrict.types.js\";\nexport default { declaredModules: [{ name: \"app\", glob: \"src/app/**\", surface: \"index.ts\" }, { name: \"shared\", glob: \"src/shared/**\", surface: \"index.ts\" }], because: \"test\" } satisfies Config;\n",
      );
      installRealArchstrictBin(root);

      const output = runHook({
        tool_name: "Edit",
        tool_input: {
          file_path: importer,
          old_string: "export const x = 1;\n",
          new_string: "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
        },
        cwd: root,
      });

      expect(output.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(output.hookSpecificOutput?.additionalContext).toContain("public-surface-bypass");
      expect(output.hookSpecificOutput?.additionalContext).toContain(importer);
      expect(output.hookSpecificOutput?.additionalContext).toContain("do:");
      // The Edit call must never actually happen - the file on disk keeps its old text.
      expect(readFileSync(importer, "utf8")).toBe("export const x = 1;\n");
    });
  });
});
