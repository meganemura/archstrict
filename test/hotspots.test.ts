// Responsibility: verify the hotspots evidence model, CLI shape, and degraded history modes.
// Boundary: fixtures use real Git repositories; graph rule behavior remains in its own tests.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  coChangeCount,
  formatHotspotsText,
  hotspots,
  summarizeCommitHistory,
  type HotspotsResult,
} from "../src/verbs/hotspots.js";

const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;
const MODULE_NAMES = ["alpha", "beta", "gamma"] as const;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

function writeProject(root: string): void {
  mkdirSync(join(root, "src", "alpha"), { recursive: true });
  mkdirSync(join(root, "src", "beta"), { recursive: true });
  writeFileSync(join(root, "src", "alpha", "index.ts"), 'import { beta } from "../beta/index.js";\nexport const alpha = beta;\n');
  writeFileSync(join(root, "src", "beta", "index.ts"), "export const beta = 1;\n");
  writeFileSync(join(root, "archstrict.config.ts"), `export default {
  schemaVersion: 1,
  surface: "index.ts",
  exclude: ["archstrict.config.ts", "archstrict.types.ts"],
  declaredModules: [
    { name: "alpha", glob: "src/alpha/**" },
    { name: "beta", glob: "src/beta/**" },
  ],
  because: "the fixture declares two module boundaries",
};\n`);
}

function commit(root: string, message: string): void {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
}

describe("hotspots", () => {
  test("reports an exact complete JSON shape from real commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-hotspots-"));
    try {
      writeProject(root);
      git(root, ["init", "-q"]);
      commit(root, "initial");
      writeFileSync(join(root, "src", "alpha", "index.ts"), 'import { beta } from "../beta/index.js";\nexport const alpha = beta;\nexport const alphaTwo = 2;\n');
      commit(root, "alpha");
      writeFileSync(join(root, "src", "alpha", "index.ts"), 'import { beta } from "../beta/index.js";\nexport const alpha = beta;\nexport const alphaTwo = 2;\nexport const alphaThree = 3;\n');
      writeFileSync(join(root, "src", "beta", "index.ts"), "export const beta = 1;\nexport const betaTwo = 2;\n");
      commit(root, "both");

      const result = await hotspots(root);
      expect(result).toEqual({
        history: { available: true, shallow: false, commits: 3, since: null, note: null },
        units: { commits: "commits", changedLines: "added plus deleted lines", shares: "fraction of module commits" },
        exclusions: ["paths outside analysis", "archstrict todo files", "archstrict.types.ts"],
        modules: [
          { name: "beta", commits: 2, changedLines: 2, fanIn: 1, fanOut: 0, frozenDebtByRule: {}, activeViolationsByRule: {}, score: 2, do: "archstrict check src/beta/index.ts" },
          { name: "alpha", commits: 3, changedLines: 4, fanIn: 0, fanOut: 1, frozenDebtByRule: {}, activeViolationsByRule: {}, score: 0, do: "archstrict check src/alpha/index.ts" },
        ],
        pairs: [
          { moduleA: "alpha", moduleB: "beta", coChanges: 2, shareOfA: 2 / 3, shareOfB: 1, boundary: true, hotspot: true },
        ],
      });

      const json = JSON.parse(execFileSync("node", [CLI_PATH, "hotspots", "--json"], { cwd: root, encoding: "utf8" }));
      expect(json).toEqual(result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds text sections to ten rows", () => {
    const modules = Array.from({ length: 12 }, (_, i) => ({
      name: `m${i}`, commits: 12 - i, changedLines: i, fanIn: i, fanOut: 0,
      frozenDebtByRule: {}, activeViolationsByRule: {}, score: (12 - i) * i, do: `archstrict check src/m${i}/index.ts`,
    }));
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      moduleA: `m${i}`, moduleB: `m${i + 1}`, coChanges: 12 - i,
      shareOfA: 0.5, shareOfB: 0.5, boundary: true, hotspot: true,
    }));
    const result: HotspotsResult = {
      history: { available: true, shallow: false, commits: 12, since: null, note: null },
      units: { commits: "commits", changedLines: "added plus deleted lines", shares: "fraction of module commits" },
      exclusions: ["paths outside analysis", "archstrict todo files", "archstrict.types.ts"],
      modules,
      pairs,
    };
    const text = formatHotspotsText(result);
    expect(text.match(/^  m\d+:/gm)).toHaveLength(10);
    expect(text.match(/^  m\d+ <-> m\d+:/gm)).toHaveLength(10);
    expect(text).toContain("Read this as:");
    expect(text.match(/^do: /gm)).toHaveLength(10);
  });

  test("keeps structure when the project has no Git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-hotspots-no-git-"));
    try {
      writeProject(root);
      const result = await hotspots(root);
      expect(result.history).toEqual({
        available: false,
        shallow: false,
        commits: 0,
        since: null,
        note: "Git history is unavailable because this project is not in a Git repository.",
      });
      expect(result.modules.map((module) => [module.name, module.fanIn, module.fanOut])).toEqual([
        ["alpha", 0, 1],
        ["beta", 1, 0],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("states that a shallow clone has limited history", async () => {
    const source = mkdtempSync(join(tmpdir(), "archstrict-hotspots-source-"));
    const clone = mkdtempSync(join(tmpdir(), "archstrict-hotspots-clone-"));
    try {
      writeProject(source);
      git(source, ["init", "-q"]);
      commit(source, "initial");
      writeFileSync(join(source, "src", "beta", "index.ts"), "export const beta = 2;\n");
      commit(source, "second");
      rmSync(clone, { recursive: true, force: true });
      execFileSync("git", ["clone", "-q", "--depth=1", `file://${source}`, clone]);
      const result = await hotspots(clone);
      expect(result.history.shallow).toBe(true);
      expect(result.history.note).toContain("shallow clone");
      expect(result.modules).toHaveLength(2);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

test("co-change counts are symmetric and shares use each module's commit count", () =>
  hegel.test((tc) => {
    const commits = tc.draw(gs.arrays(gs.arrays(gs.sampledFrom([...MODULE_NAMES]), { unique: true, maxSize: 3 }), { maxSize: 30 }));
    const summary = summarizeCommitHistory([...MODULE_NAMES], commits.map((modules) => ({ modules: new Set(modules), linesByModule: new Map() })));
    for (const a of MODULE_NAMES) {
      for (const b of MODULE_NAMES) {
        if (a === b) continue;
        assert.equal(coChangeCount(commits, a, b), coChangeCount(commits, b, a));
      }
    }
    for (const pair of summary.pairs) {
      const count = coChangeCount(commits, pair.moduleA, pair.moduleB);
      assert.equal(pair.coChanges, count);
      assert.equal(pair.shareOfA, count / summary.commitsByModule.get(pair.moduleA)!);
      assert.equal(pair.shareOfB, count / summary.commitsByModule.get(pair.moduleB)!);
    }
  }));
