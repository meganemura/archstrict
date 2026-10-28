// The converter scripts stay .mjs subprocesses, the same shape
// probe-typescript7.test.ts runs. scripts/ is in the typecheck include,
// and tsc still skips .mjs, so these tests spawn the scripts instead of
// importing them. The generated fixtures are imported so tsc checks them
// even though test/fixtures/ is excluded: an import from an included file
// still pulls an excluded file into the program (see test/classify.test.ts).
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import prismaGenerated from "./fixtures/vendored/prisma-generated.config.js";
import vscodeGenerated from "./fixtures/vendored/vscode-generated.config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED = join(HERE, "fixtures/vendored");
const SCRIPTS = join(HERE, "..", "scripts");

function runWithNoArgsFromSpacedPath(scriptName: string) {
  const dir = mkdtempSync(join(tmpdir(), "archstrict converter "));
  try {
    const copied = join(dir, scriptName);
    copyFileSync(join(SCRIPTS, scriptName), copied);
    // macOS /tmp is a symlink. argv keeps the path you pass, and the module
    // URL uses the real path. Resolve first so the space is the only mismatch.
    const script = realpathSync(copied);
    expect(script.includes(" ")).toBe(true);
    return spawnSync(process.execPath, [script], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWithNoArgsThroughSymlink(scriptName: string, relative: boolean) {
  const realDir = mkdtempSync(join(tmpdir(), "archstrict-converter-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "archstrict-converter-link-"));
  const linkDir = join(linkParent, "scripts");
  try {
    copyFileSync(join(SCRIPTS, scriptName), join(realDir, scriptName));
    // Point the link at the real directory. Passing linkDir to node keeps a
    // symlink in argv. realpath first would hide the mismatch this covers.
    symlinkSync(realpathSync(realDir), linkDir, "dir");
    const script = join(linkDir, scriptName);
    expect(realpathSync(script)).not.toBe(script);
    if (relative) {
      return spawnSync(process.execPath, [`./${scriptName}`], { cwd: linkDir, encoding: "utf8" });
    }
    return spawnSync(process.execPath, [script], { encoding: "utf8" });
  } finally {
    rmSync(linkDir, { force: true });
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  }
}

function regenerate(scriptName: string, inputName: string): string {
  const outDir = mkdtempSync(join(tmpdir(), "archstrict-converter-"));
  const outPath = join(outDir, "out.config.ts");
  try {
    execFileSync("node", [join(SCRIPTS, scriptName), join(VENDORED, inputName), outPath]);
    return readFileSync(outPath, "utf8");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe("convert-prisma-architecture-config.mjs", () => {
  test("emits one classify entry per real package.glob, with the real domain/layer/plane tags", () => {
    expect(prismaGenerated.classify).toHaveLength(123);
    expect(prismaGenerated.classify[0]).toEqual({
      glob: "packages/1-framework/0-foundation/**",
      tags: ["domain:framework", "layer:foundation", "plane:shared"],
    });
    // Spot-check the file-level override entry (not just directory globs).
    const controlTs = prismaGenerated.classify.find((e) => e.glob.endsWith("exports/control.ts"));
    expect(controlTs).toBeDefined();
    expect(controlTs!.tags).toContain("plane:migration");
  });

  test("emits allowDeny from crossDomainRules using allow (mayImportFrom), matching dependency-cruiser's own createCrossDomainRules (reads mayImportFrom only)", () => {
    const allowDeny = prismaGenerated.edges.allowDeny!;
    const framework = allowDeny.find((r) => r.source === "domain:framework");
    expect(framework).toBeDefined();
    expect(framework!.allow).toEqual([]);
    expect(framework!.deny).toBeUndefined();

    const sql = allowDeny.find((r) => r.source === "domain:sql");
    expect(sql!.allow).toEqual(["framework"]);
  });

  test("emits allowDeny from planeRules using deny (forbid), matching dependency-cruiser's own createPlaneRules (reads forbid only, never allow)", () => {
    const shared = prismaGenerated.edges.allowDeny!.find((r) => r.source === "plane:shared");
    expect(shared).toBeDefined();
    expect(shared!.deny).toEqual(["migration", "runtime"]);
    expect(shared!.allow).toBeUndefined();
  });

  test("emits one order rule with the real layerOrder object verbatim as its sequence", () => {
    const order = prismaGenerated.edges.order!;
    expect(order).toHaveLength(1);
    expect(order[0]!.tagNamespace).toBe("layer");
    expect(order[0]!.within).toBe("domain");
    expect(order[0]!.sequence["sql"]).toEqual([
      "core",
      "authoring",
      "tooling",
      "lanes",
      "runtime",
      "adapters",
      "drivers",
      "family",
    ]);
  });

  test("prints its usage line and exits 1 when the script path contains a space", () => {
    const result = runWithNoArgsFromSpacedPath("convert-prisma-architecture-config.mjs");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: convert-prisma-architecture-config.mjs <architecture.config.json> [output.ts]\n",
    );
  });

  test("prints its usage line and exits 1 when an absolute path reaches it through a symlink", () => {
    const result = runWithNoArgsThroughSymlink("convert-prisma-architecture-config.mjs", false);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: convert-prisma-architecture-config.mjs <architecture.config.json> [output.ts]\n",
    );
  });

  test("prints its usage line and exits 1 for a relative invocation from a symlink directory", () => {
    const result = runWithNoArgsThroughSymlink("convert-prisma-architecture-config.mjs", true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: convert-prisma-architecture-config.mjs <architecture.config.json> [output.ts]\n",
    );
  });

  test("the committed fixture is not stale: regenerating from the same vendored input produces the identical file", () => {
    const fresh = regenerate("convert-prisma-architecture-config.mjs", "prisma-architecture.config.json");
    const committed = readFileSync(join(VENDORED, "prisma-generated.config.ts"), "utf8")
      // The committed fixture's import path differs on purpose (this
      // project's own src/config/config.js, not a real project's generated
      // file) - normalize both sides before comparing everything else.
      .replace('import type { Config } from "../../../src/config/config.js";', 'import type { Config } from "./archstrict.types.js";');
    expect(fresh).toBe(committed);
  });
});

describe("convert-vscode-layering-config.mjs", () => {
  test("emits classifyByDirectoryName naming all 6 real layers", () => {
    expect(vscodeGenerated.classifyByDirectoryName!.tagNamespace).toBe("env");
    expect(vscodeGenerated.classifyByDirectoryName!.names).toEqual([
      "common",
      "node",
      "browser",
      "electron-browser",
      "electron-utility",
      "electron-main",
    ]);
  });

  test("emits one allowDeny entry per layer with its real allowed-list, matching code-layering.ts's own table exactly", () => {
    const allowDeny = vscodeGenerated.edges.allowDeny!;
    const electronMain = allowDeny.find((r) => r.source === "env:electron-main");
    expect(electronMain!.allow).toEqual(["common", "node", "electron-utility"]);

    const common = allowDeny.find((r) => r.source === "env:common");
    expect(common!.allow).toEqual([]); // common may reach nothing else
  });

  test("prints its usage line and exits 1 when the script path contains a space", () => {
    const result = runWithNoArgsFromSpacedPath("convert-vscode-layering-config.mjs");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: convert-vscode-layering-config.mjs <code-layering-table.json> [output.ts]\n",
    );
  });

  test("prints its usage line and exits 1 when an absolute path reaches it through a symlink", () => {
    const result = runWithNoArgsThroughSymlink("convert-vscode-layering-config.mjs", false);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: convert-vscode-layering-config.mjs <code-layering-table.json> [output.ts]\n",
    );
  });

  test("prints its usage line and exits 1 for a relative invocation from a symlink directory", () => {
    const result = runWithNoArgsThroughSymlink("convert-vscode-layering-config.mjs", true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: convert-vscode-layering-config.mjs <code-layering-table.json> [output.ts]\n",
    );
  });

  test("the committed fixture is not stale: regenerating from the same vendored input produces the identical file", () => {
    const fresh = regenerate("convert-vscode-layering-config.mjs", "vscode-code-layering.json");
    const committed = readFileSync(join(VENDORED, "vscode-generated.config.ts"), "utf8").replace(
      'import type { Config } from "../../../src/config/config.js";',
      'import type { Config } from "./archstrict.types.js";',
    );
    expect(fresh).toBe(committed);
  });
});
