// Responsibility: prepare the tree the suite runs against.
// Boundary: suite setup only; test cases remain in their own files.
// Builds dist/ before tests. Also recreates the plugin-layout symlinks when
// they are absent. Stryker's sandbox copy uses copyFile, which throws EISDIR
// on the directory symlinks hooks and mcp and would flatten the plugin.json
// symlink into a normal file. stryker.config.json ignores those three paths,
// and this setup puts the links back so the layout test still sees them.
import { execFileSync } from "node:child_process";
import { lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function ensureSymlink(linkPath: string, target: string): void {
  try {
    lstatSync(linkPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  symlinkSync(target, linkPath);
}

export default function setup(): void {
  ensureSymlink(join(root, "hooks"), ".agents/hooks");
  ensureSymlink(join(root, "mcp"), ".agents/mcp");
  ensureSymlink(join(root, ".claude-plugin", "plugin.json"), "../.agents/plugin.json");
  execFileSync("npm", ["run", "build"], { cwd: root });
}
