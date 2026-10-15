import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { diagram, type DiagramOptions } from "../src/verbs/diagram.js";
import { REPO, materialize } from "./diagram-project.js";

const CLI_PATH = join(REPO, "dist", "cli.js");
const defaults: DiagramOptions = { format: "mermaid", direction: "TB", detail: "rules" };

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI_PATH, "diagram", ...args], { cwd, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("archstrict diagram (CLI)", () => {
  test("prints the Mermaid text, the same document as the API, and writes nothing", async () => {
    const dir = materialize("kitchen-sink");
    try {
      const out = run(dir, []);
      expect(out.status).toBe(0);
      expect(out.stdout).toBe((await diagram(dir, defaults)).text);
      expect(out.stdout.startsWith("flowchart TB\n")).toBe(true);
      expect(existsSync(join(dir, "archstrict.types.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("--format markdown prints a heading, a fenced diagram, and a legend", () => {
    const dir = materialize("kitchen-sink");
    try {
      const out = run(dir, ["--format", "markdown", "--direction", "LR"]);
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/^## archstrict-diagram-kitchen-sink-\w+ architecture\n\n```mermaid\nflowchart LR\n/);
      expect(out.stdout).toContain("\n```\n\n| Look | Meaning |\n| --- | --- |\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("--json prints one object with the document, the nodes, and the links", () => {
    const dir = materialize("kitchen-sink");
    try {
      const out = run(dir, ["--json", "--focus", "vendor", "--detail", "names"]);
      expect(out.status).toBe(0);
      const json = JSON.parse(out.stdout);
      expect(Object.keys(json)).toEqual(["configPath", "format", "direction", "detail", "focus", "text", "modules", "layers", "selectors", "packages", "links", "legend"]);
      expect(json.focus).toBe("vendor");
      expect(json.modules).toEqual([{ name: "vendor", node: "m4", layer: null, tags: [] }]);
      expect(json.links).toEqual([
        { kind: "forbid", from: "m4", to: "k2", rule: "edges.point[1]", qualifier: null, because: "vendored code stays free of Node builtins", packages: ["node"] },
      ]);
      expect(json.packages).toEqual([{ node: "k2", names: ["node"] }]);
      expect(json.text.startsWith("flowchart TB\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unknown module reports the valid names and exits 1, in text and in JSON", () => {
    const dir = materialize("kitchen-sink");
    try {
      const text = run(dir, ["--focus", "nope"]);
      expect(text.status).toBe(1);
      expect(text.stderr).toMatch(/^archstrict: no declared module named 'nope'\ndo: archstrict diagram --focus <one of: kernel, domain, shell, store, vendor, /);
      const json = run(dir, ["--focus", "nope", "--json"]);
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout).error).toBe("no declared module named 'nope'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a missing config reports where to run the command", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstrict-diagram-empty-"));
    try {
      const out = run(dir, []);
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(/^archstrict: .*archstrict\.config\.ts does not exist\ndo: archstrict init\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    [["--format", "html"]],
    [["--direction", "up"]],
    [["--detail", "all"]],
    [["--focus"]],
    [["--format", "mermaid", "--format", "markdown"]],
    [["--bogus"]],
    [["extra"]],
  ])("%j is a usage error", (args) => {
    const out = run(tmpdir(), args);
    expect(out.status).toBe(1);
    expect(out.stderr).toBe(
      "archstrict: usage: archstrict diagram [--format mermaid|markdown] [--direction TB|BT|LR|RL] [--detail names|rules|reasons] [--focus <module>] [--json]\ndo: archstrict diagram --help\n",
    );
  });
});
