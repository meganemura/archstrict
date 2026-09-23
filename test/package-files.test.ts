// `package.json`'s `files` allowlist is the published surface. dist/ is the
// CLI; the skill and llms.txt are how an agent that installed the package,
// and never cloned this repository, finds the workflow. `npm pack --dry-run`
// is the same file list installing the tarball would get.
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const SKILL_PATHS = [
  "llms.txt",
  "skills/archstrict/SKILL.md",
  "skills/archstrict/references/config.md",
  "skills/archstrict/references/rules.md",
  "skills/archstrict/references/hook.md",
];

describe("npm pack", () => {
  test("ships the agent skill and llms.txt", () => {
    const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const packed = JSON.parse(stdout) as { files: { path: string }[] }[];
    const paths = new Set(packed[0]?.files.map((file) => file.path));
    for (const skillPath of SKILL_PATHS) {
      expect(paths, skillPath).toContain(skillPath);
    }
  });
});
