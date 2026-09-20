// Only the committed generated fixtures are imported here (never the
// .mjs converter scripts themselves - scripts/ is deliberately outside
// tsconfig's own `include`, same convention probe-typescript7.test.ts
// already established: a script is a subprocess to run, not a module to
// import into a typechecked file). Importing them here forces tsc to
// check them despite test/fixtures/ itself being excluded (see
// test/classify.test.ts's own header for why an explicit import from an
// included file still pulls an excluded one into the program).
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import prismaGenerated from "./fixtures/vendored/prisma-generated.config.js";
import vscodeGenerated from "./fixtures/vendored/vscode-generated.config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED = join(HERE, "fixtures/vendored");
const SCRIPTS = join(HERE, "..", "scripts");

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

  test("the committed fixture is not stale: regenerating from the same vendored input produces the identical file", () => {
    const fresh = regenerate("convert-prisma-architecture-config.mjs", "prisma-architecture.config.json");
    const committed = readFileSync(join(VENDORED, "prisma-generated.config.ts"), "utf8")
      // The committed fixture's import path differs on purpose (this
      // project's own src/config.js, not a real project's generated
      // file) - normalize both sides before comparing everything else.
      .replace('import type { Config } from "../../../src/config.js";', 'import type { Config } from "./archstrict.generated.js";');
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

  test("the committed fixture is not stale: regenerating from the same vendored input produces the identical file", () => {
    const fresh = regenerate("convert-vscode-layering-config.mjs", "vscode-code-layering.json");
    const committed = readFileSync(join(VENDORED, "vscode-generated.config.ts"), "utf8").replace(
      'import type { Config } from "../../../src/config.js";',
      'import type { Config } from "./archstrict.generated.js";',
    );
    expect(fresh).toBe(committed);
  });
});
