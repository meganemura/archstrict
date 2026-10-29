// declaredModules[].visibility: a module that only files matching one glob
// may import. Inside the glob the module is an ordinary module, with its
// surface public and its internals private. Outside it, even the surface is
// a bypass, unless a friends entry names the importer.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/graph/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe("declaredModules[].visibility", () => {
  test("files inside the visibility import the surface, files outside it may not, and a friend still may", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-visibility-"));
    try {
      write(root, "src/records/store/store.ts", "export const row = 1;\n");
      write(root, "src/records/store/internal.ts", "export const hidden = 1;\n");
      write(root, "src/records/claims/claims.ts", 'import { row } from "../store/store.js";\nexport const claim = row;\n');
      write(root, "src/records/claims/peek.ts", 'import { hidden } from "../store/internal.js";\nexport const peek = hidden;\n');
      write(root, "src/records/index.ts", 'export { claim } from "./claims/claims.js";\n');
      write(
        root,
        "src/cli.ts",
        'import { claim } from "./records/index.js";\nimport { row } from "./records/store/store.js";\nimport { hidden } from "./records/store/internal.js";\nexport const all = [claim, row, hidden];\n',
      );
      write(root, "src/tools/dump.ts", 'import { row } from "../records/store/store.js";\nexport const dump = row;\n');

      const inRecords = "src/records/**";
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "records", glob: "src/records/*.ts", surface: "index.ts" },
          {
            name: "records/store",
            glob: "src/records/store/**",
            surface: "store.ts",
            visibility: inRecords,
            friends: [{ file: "store.ts", from: "src/tools/**", because: "the dump tool reads rows directly" }],
          },
          { name: "records/claims", glob: "src/records/claims/**", surface: "claims.ts", visibility: inRecords },
          { name: "cli", glob: "src/cli.ts", surface: "cli.ts" },
          { name: "tools", glob: "src/tools/**", surface: "dump.ts" },
        ],
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);

      const found = checkPublicSurfaceBypass(graph).map((v) => ({
        from: v.path.slice(root.length + 1),
        specifier: v.specifier,
        evidence: v.evidence,
        do: v.do,
      }));
      expect(found).toEqual([
        {
          from: "src/cli.ts",
          specifier: "./records/store/store.js",
          evidence: "'./records/store/store.js' resolved to module 'records/store', which only files matching 'src/records/**' may import",
          do: "import it through a module that src/cli.ts may import, or widen visibility on module 'records/store' in archstrict.config.ts",
        },
        {
          from: "src/cli.ts",
          specifier: "./records/store/internal.js",
          evidence: "'./records/store/internal.js' resolved to module 'records/store', which only files matching 'src/records/**' may import",
          do: "import it through a module that src/cli.ts may import, or widen visibility on module 'records/store' in archstrict.config.ts",
        },
        {
          from: "src/records/claims/peek.ts",
          specifier: "../store/internal.js",
          evidence: "'../store/internal.js' resolved to a file inside module 'records/store' other than its store.ts",
          do: "import from src/records/store/store.ts instead of src/records/store/internal.ts, adding the export there first if it is missing",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
