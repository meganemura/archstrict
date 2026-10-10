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
          { name: "beta", commits: 2, changedLines: 2, fanIn: 1, fanOut: 0, frozenDebtByRule: {}, activeViolationsByRule: {}, score: 2, do: "archstrict check --frozen --module beta" },
          { name: "alpha", commits: 3, changedLines: 4, fanIn: 0, fanOut: 1, frozenDebtByRule: {}, activeViolationsByRule: {}, score: 0, do: "archstrict check --frozen --module alpha" },
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

  test("bounds text sections to ten rows and the do: lines to two", () => {
    const modules = Array.from({ length: 12 }, (_, i) => ({
      name: `m${i}`, commits: 12 - i, changedLines: i, fanIn: i, fanOut: 0,
      frozenDebtByRule: {}, activeViolationsByRule: {}, score: (12 - i) * i, do: `archstrict check --frozen --module m${i}`,
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
    const doLines = text.match(/^do: .*$/gm);
    expect(doLines).toEqual([
      "do: archstrict check --frozen --module m0",
      "do: read node_modules/archstrict/skills/archstrict/references/rearchitect.md, then run archstrict check --frozen --module m0 and archstrict check --frozen --module m1",
    ]);
  });

  test("emits only the top-module do: line when no boundary-hotspot pair exists", () => {
    const modules = [
      { name: "alpha", commits: 3, changedLines: 4, fanIn: 0, fanOut: 1, frozenDebtByRule: {}, activeViolationsByRule: {}, score: 0, do: "archstrict check --frozen --module alpha" },
    ];
    const pairs: HotspotsResult["pairs"] = [];
    const result: HotspotsResult = {
      history: { available: true, shallow: false, commits: 1, since: null, note: null },
      units: { commits: "commits", changedLines: "added plus deleted lines", shares: "fraction of module commits" },
      exclusions: ["paths outside analysis", "archstrict todo files", "archstrict.types.ts"],
      modules,
      pairs,
    };
    const text = formatHotspotsText(result);
    expect(text.match(/^do: .*$/gm)).toEqual(["do: archstrict check --frozen --module alpha"]);
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
      expect(formatHotspotsText(result).match(/^do: .*$/gm)).toEqual([
        "do: run archstrict hotspots inside a git repository",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without git history, do: names the module with the most active violations", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-hotspots-no-git-violations-"));
    try {
      mkdirSync(join(root, "src", "alpha"), { recursive: true });
      mkdirSync(join(root, "src", "zeta"), { recursive: true });
      writeFileSync(join(root, "src", "alpha", "index.ts"), 'import { hidden } from "../zeta/hidden.js";\nexport const alpha = hidden;\n');
      writeFileSync(join(root, "src", "zeta", "hidden.ts"), "export const hidden = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"), `export default {
  schemaVersion: 1,
  surface: "index.ts",
  exclude: ["archstrict.config.ts", "archstrict.types.ts"],
  declaredModules: [
    { name: "alpha", glob: "src/alpha/**" },
    { name: "zeta", glob: "src/zeta/**" },
  ],
  because: "the fixture gives the later module the active violation",
};\n`);
      const result = await hotspots(root);
      expect(result.history.available).toBe(false);
      expect(result.modules.map((module) => module.name)).toEqual(["alpha", "zeta"]);
      expect(result.modules[0]?.activeViolationsByRule).toEqual({});
      expect(result.modules[1]?.activeViolationsByRule).toEqual({ "public-surface-bypass": 1 });
      expect(formatHotspotsText(result).match(/^do: .*$/gm)).toEqual([
        "do: archstrict check --frozen --module zeta",
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

test("without git history the leading do names the busiest module, or a git repository", () =>
  hegel.test((tc) => {
    const size = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
    const modules = Array.from({ length: size }, (_, index) => {
      const violations = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const activeViolationsByRule: Record<string, number> = {};
      if (violations > 0) activeViolationsByRule["public-surface-bypass"] = violations;
      return {
        name: `m${index}`,
        commits: 0,
        changedLines: 0,
        fanIn: 0,
        fanOut: 0,
        frozenDebtByRule: {},
        activeViolationsByRule,
        score: 0,
        do: `archstrict check --frozen --module m${index}`,
      };
    });
    const result: HotspotsResult = {
      history: { available: false, shallow: false, commits: 0, since: null, note: "Git history is unavailable because this project is not in a Git repository." },
      units: { commits: "commits", changedLines: "added plus deleted lines", shares: "fraction of module commits" },
      exclusions: ["paths outside analysis", "archstrict todo files", "archstrict.types.ts"],
      modules,
      pairs: [],
    };
    const doLine = formatHotspotsText(result).match(/^do: .*$/m)?.[0];
    const best = modules.reduce<{ name: string; count: number } | undefined>((winner, module) => {
      const count = Object.values(module.activeViolationsByRule).reduce((sum, value) => sum + value, 0);
      if (count === 0) return winner;
      if (winner === undefined || count > winner.count || (count === winner.count && module.name.localeCompare(winner.name) < 0)) {
        return { name: module.name, count };
      }
      return winner;
    }, undefined);
    assert.equal(
      doLine,
      best === undefined
        ? "do: run archstrict hotspots inside a git repository"
        : `do: archstrict check --frozen --module ${best.name}`,
    );
  }));

// Independent count of commits that contain both modules.
// Production history goes through summarizeCommitHistory, so this oracle stays in the test.
function coChangeCount(commits: readonly (readonly string[])[], a: string, b: string): number {
  let count = 0;
  for (const commit of commits) {
    const modules = new Set(commit);
    if (modules.has(a) && modules.has(b)) count++;
  }
  return count;
}

test("co-change counts match an independent count and shares use each module's commit count", () =>
  hegel.test((tc) => {
    const commits = tc.draw(gs.arrays(gs.arrays(gs.sampledFrom([...MODULE_NAMES]), { unique: true, maxSize: 3 }), { maxSize: 30 }));
    const summary = summarizeCommitHistory([...MODULE_NAMES], commits.map((modules) => ({ modules: new Set(modules), linesByModule: new Map() })));
    for (const pair of summary.pairs) {
      const count = coChangeCount(commits, pair.moduleA, pair.moduleB);
      assert.equal(pair.coChanges, count);
      assert.equal(pair.shareOfA, count / summary.commitsByModule.get(pair.moduleA)!);
      assert.equal(pair.shareOfB, count / summary.commitsByModule.get(pair.moduleB)!);
    }
  }));
