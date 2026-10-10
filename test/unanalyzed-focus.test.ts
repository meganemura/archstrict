// A path argument that names a file the analysis did not read must say so
// in text, and must leave the JSON result unchanged. The PostToolUse hook
// reads check --json and stays silent when violations is empty.
import * as assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, formatText, hasBlockingViolations } from "../src/verbs/check.js";
import { fix } from "../src/verbs/fix.js";
import { classifyFocus } from "../src/verbs/focus-note.js";
import { formatSimulateText, simulate } from "../src/verbs/simulate.js";
import { ReportError } from "../src/report-error.js";

const CONFIG = {
  declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
  exclude: ["**/*.test.ts", "archstrict.config.ts"],
  because: "test",
};

async function project(run: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-unanalyzed-")));
  try {
    mkdirSync(join(root, "src", "app"), { recursive: true });
    writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
    writeFileSync(join(root, "src", "app", "main.test.ts"), "export const t = 1;\n");
    writeFileSync(join(root, "src", "app", "types.d.ts"), "export interface T { value: number }\n");
    writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify(CONFIG)};\n`);
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function noteLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("note:"));
}

describe("classifyFocus", () => {
  test("keeps one reason, and outside wins over every other fact", () => {
    hegel.test((tc) => {
      const outside = tc.draw(gen.booleans());
      const directory = tc.draw(gen.booleans());
      const configFile = tc.draw(gen.booleans());
      const excluded = tc.draw(gen.booleans());
      const eligible = tc.draw(gen.booleans());
      const reason = classifyFocus({ outside, directory, configFile, excluded, eligible });
      if (outside) assert.equal(reason, "outside");
      else if (directory || configFile) assert.equal(reason, undefined);
      else if (excluded) assert.equal(reason, "excluded");
      else if (eligible) assert.equal(reason, undefined);
      else assert.equal(reason, "unanalyzed");
    });
  });
});

describe("check and simulate text notes", () => {
  test("an analyzed file and a directory scope print no note", async () => project(async (root) => {
    const file = await check(root, join(root, "src", "app", "index.ts"));
    expect(noteLines(formatText(file))).toEqual([]);
    expect(hasBlockingViolations(file)).toBe(false);
    const directory = await check(root, join(root, "src", "app"));
    expect(noteLines(formatText(directory))).toEqual([]);
  }));

  test("an excluded test file, a file outside the project, package.json, and a .d.ts each print one note, and JSON omits it", async () => project(async (root) => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-outside-")));
    const outside = join(outsideDir, "other.ts");
    writeFileSync(outside, "export const x = 1;\n");
    try {
      const cases = [
        [join(root, "src", "app", "main.test.ts"), `${join(root, "src", "app", "main.test.ts")} is excluded, so it was not analyzed`],
        [outside, `${outside} is outside the project, so it was not analyzed`],
        [join(root, "package.json"), `${join(root, "package.json")} was not analyzed`],
        [join(root, "src", "app", "types.d.ts"), `${join(root, "src", "app", "types.d.ts")} was not analyzed`],
      ] as const;
      for (const [file, sentence] of cases) {
        const result = await check(root, file);
        expect(noteLines(formatText(result))).toEqual([`note: ${sentence}`]);
        expect(result.violations).toEqual([]);
        expect(hasBlockingViolations(result)).toBe(false);
        expect(JSON.stringify(result)).not.toContain("was not analyzed");
        expect(JSON.stringify(result)).not.toContain("is excluded");
        expect(JSON.stringify(result)).not.toContain("outside the project");
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }));

  test("a .d.ts named as a surface is analyzed", async () => project(async (root) => {
    writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
      declaredModules: [{ name: "app", glob: "src/app/**", surface: "types.d.ts" }],
      exclude: ["archstrict.config.ts"],
      because: "test",
    })};\n`);
    const result = await check(root, join(root, "src", "app", "types.d.ts"));
    expect(noteLines(formatText(result))).toEqual([]);
  }));

  test("simulate prints one note for an outside path and keeps an empty JSON comparison", async () => project(async (root) => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-sim-outside-")));
    const outside = join(outsideDir, "other.ts");
    writeFileSync(outside, "export const x = 1;\n");
    try {
      const result = await simulate(root, [{ path: outside, content: "export const x = 1;\n" }]);
      expect(noteLines(formatSimulateText(result))).toEqual([
        `note: ${outside} is outside the project, so it was not analyzed`,
      ]);
      expect(result).toMatchObject({ mode: "scoped", added: [], resolved: [], unchangedCount: 0 });
      expect(JSON.stringify(result)).not.toContain("outside the project");
      const cli = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "simulate"], {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({ changes: [{ path: outside, content: "export const x = 1;\n" }] }),
      });
      expect(cli.status).toBe(0);
      expect(noteLines(cli.stdout)).toEqual([`note: ${outside} is outside the project, so it was not analyzed`]);
      const json = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "simulate", "--json"], {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({ changes: [{ path: outside, content: "export const x = 1;\n" }] }),
      });
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ mode: "scoped", added: [], resolved: [], unchangedCount: 0 });
      expect(json.stdout).not.toContain("outside the project");
      const excluded = await simulate(root, [{ path: "src/app/main.test.ts", content: "export const t = 1;\n" }]);
      expect(noteLines(formatSimulateText(excluded))).toEqual([
        "note: src/app/main.test.ts is excluded, so it was not analyzed",
      ]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }));

  test("fix on a missing file throws the no such file ReportError", async () => project(async (root) => {
    const error = await fix(root, "src/shared/nope.ts").then(() => {
      throw new Error("fix resolved");
    }, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReportError);
    expect(error).toMatchObject({
      message: "fix src/shared/nope.ts: no such file",
      do: "archstrict fix",
    });
  }));
});
