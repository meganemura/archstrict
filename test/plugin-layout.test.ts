// Responsibility: lock the Claude Code plugin layout.
// Boundary: filesystem layout only. No rule logic.
// Canonical files live under `.agents/`. Claude still resolves the
// plugin-root paths it expects because those paths are symlinks.
// `.claude-plugin/` stays a real directory with only the manifest
// symlink: Claude loads hooks from the plugin root (the directory that
// contains `.claude-plugin/`), and a directory symlink onto `.agents/`
// would place `hooks/` and `mcp/` inside `.claude-plugin/`.
import { expect, test } from "vitest";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Claude plugin paths symlink onto .agents and the manifest paths exist", () => {
  const manifestLink = join(root, ".claude-plugin", "plugin.json");
  const manifest = join(root, ".agents", "plugin.json");
  expect(lstatSync(join(root, ".claude-plugin")).isDirectory()).toBe(true);
  expect(lstatSync(manifestLink).isSymbolicLink()).toBe(true);
  expect(realpathSync(manifestLink)).toBe(realpathSync(manifest));

  for (const name of ["hooks", "mcp"]) {
    const link = join(root, name);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(root, ".agents", name)));
  }

  const plugin = JSON.parse(readFileSync(manifest, "utf8")) as {
    hooks: string[];
    mcpServers: { archstrict: { args: string[] } };
  };
  const hooksConfig = plugin.hooks[0]!.replace(/^\.\//, "");
  expect(lstatSync(join(root, hooksConfig)).isFile()).toBe(true);
  const mcpArg = plugin.mcpServers.archstrict.args[0]!.replace("${CLAUDE_PLUGIN_ROOT}/", "");
  expect(lstatSync(join(root, mcpArg)).isFile()).toBe(true);

  const hooks = JSON.parse(readFileSync(join(root, hooksConfig), "utf8")) as {
    hooks: { PostToolUse: { hooks: { command: string }[] }[] };
  };
  const command = hooks.hooks.PostToolUse[0]!.hooks[0]!.command;
  const script = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)?.[1];
  expect(script).toBeDefined();
  expect(lstatSync(join(root, script!)).isFile()).toBe(true);
});
