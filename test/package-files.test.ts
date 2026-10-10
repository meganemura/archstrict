// `package.json`'s `files` allowlist is the published surface. dist/ is the
// CLI; the skill and llms.txt are how an agent that installed the package,
// and never cloned this repository, finds the workflow. `npm pack --dry-run
// --ignore-scripts` is the same file list installing the tarball would get.
// `prepare` is `npm run build`, and `npm pack` runs it unless scripts are
// ignored. Global setup already built `dist/`.
import { describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SKILL_PATHS = [
  "llms.txt",
  "skills/archstrict/SKILL.md",
  "skills/archstrict/references/config.md",
  "skills/archstrict/references/rules.md",
  "skills/archstrict/references/hook.md",
];

// One pack for this file. The tests below read the same list.
const packedFiles: { path: string }[] = (() => {
  const stdout = execSync("npm pack --dry-run --ignore-scripts --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const packed = JSON.parse(stdout) as { files: { path: string }[] }[];
  return packed[0]?.files ?? [];
})();

describe("npm pack", () => {
  test("ships the agent skill and llms.txt", () => {
    const paths = new Set(packedFiles.map((file) => file.path));
    for (const skillPath of SKILL_PATHS) {
      expect(paths, skillPath).toContain(skillPath);
    }
  });

  // A relative link in a shipped .md or llms.txt file is only real for an
  // agent that installed the tarball (never cloned the repository) when its
  // target is also in the packed set - a link into test/ or .claude-team/
  // would look fine in this checkout and break for that agent.
  test("every relative link in a shipped .md file or llms.txt resolves inside the packed file list", () => {
    const files = packedFiles.map((file) => file.path);
    const packedSet = new Set(files);
    const docFiles = files.filter((path) => path.endsWith(".md") || path === "llms.txt");
    expect(docFiles.length).toBeGreaterThan(0);

    const brokenLinks: string[] = [];
    for (const docPath of docFiles) {
      const text = readFileSync(join(REPO_ROOT, docPath), "utf8");
      // Strip fenced code blocks first: a config fragment inside one can
      // contain a literal `](...)` that is not a real markdown link.
      const withoutFences = text.replace(/```[\s\S]*?```/g, "");
      const linkPattern = /\]\(([^)]+)\)/g;
      for (const match of withoutFences.matchAll(linkPattern)) {
        const target = match[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, etc.
        if (target.startsWith("#")) continue; // same-file fragment
        const withoutFragment = target.split("#")[0]!;
        if (withoutFragment === "") continue;
        const resolved = posix.normalize(
          posix.join(posix.dirname(docPath), withoutFragment),
        );
        if (!packedSet.has(resolved)) {
          brokenLinks.push(`${docPath} -> ${target} (resolved: ${resolved})`);
        }
      }
    }
    expect(brokenLinks).toEqual([]);
  });

  test("the packed file list contains no test/, .claude-team/, or .agents/skills/ path", () => {
    const files = packedFiles.map((file) => file.path);
    // `files` includes `.agents` so the plugin ships. A path under
    // `.agents/skills/` is the contributor skill, and this test rejects it.
    const forbidden = files.filter(
      (path) =>
        path.startsWith("test/") ||
        path.startsWith(".claude-team/") ||
        path.startsWith(".agents/skills/"),
    );
    expect(forbidden).toEqual([]);
  });
});

test("plugin.json version matches package.json", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  const pluginJson = JSON.parse(readFileSync(join(REPO_ROOT, ".agents/plugin.json"), "utf8")) as { version: string };
  expect(pluginJson.version).toBe(packageJson.version);
});
