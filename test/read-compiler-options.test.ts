// module-graph.ts's own readCompilerOptions parses a tsconfig.json for its
// `.options` alone; it never reads the file list parseJsonConfigFileContent
// would otherwise expand `include`/`exclude` into. The fix
// (`noExpandParseConfigHost`, module-graph.ts) hands that call a
// ParseConfigHost whose `readDirectory` returns `[]` instead of `ts.sys`,
// so it stops walking the project tree for a file list the caller was
// always going to discard. This test holds the resolved options identical
// across that change: it runs the exact same `ts.readConfigFile` +
// `parseJsonConfigFileContent` pair archstrict uses, once against `ts.sys`
// (today's call, before the fix) and once against a stub host with the
// same `readDirectory: () => []` shape as the fix, on a real tsconfig.json
// that both `extends` a base config and sits nested under it - the two
// shapes readCompilerOptions itself is called against (the project root,
// and a leaf package's own nearer config).
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

// The same stub shape as module-graph.ts's noExpandParseConfigHost -
// duplicated here rather than imported, since that constant is not
// exported (an internal detail of one function, not a boundary this
// project's own module-graph.ts chooses to expose) - a literal copy makes
// this test independent of whether that name or shape later changes for
// an unrelated reason, while still exercising the exact same real
// TypeScript call this project's own code makes.
const noExpandHost: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: (p) => ts.sys.fileExists(p),
  readFile: (p) => ts.sys.readFile(p),
};

function optionsFor(configPath: string, host: ts.ParseConfigHost): ts.CompilerOptions {
  const { config } = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  return ts.parseJsonConfigFileContent(config, host, dirname(configPath)).options;
}

describe("readCompilerOptions: options identical with readDirectory stubbed to []", () => {
  test("a root tsconfig.json with a real include glob over many files", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-read-compiler-options-"));
    try {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      mkdirSync(join(root, "src", "b"), { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(root, "src", "a", `f${i}.ts`), "export const x = 1;\n");
        writeFileSync(join(root, "src", "b", `f${i}.ts`), "export const x = 1;\n");
      }
      const configPath = join(root, "tsconfig.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: "esnext",
            module: "nodenext",
            moduleResolution: "nodenext",
            strict: true,
            baseUrl: ".",
            paths: { "@/*": ["./src/*"] },
          },
          include: ["src/**/*"],
        }),
      );

      const withSys = optionsFor(configPath, ts.sys);
      const withStub = optionsFor(configPath, noExpandHost);
      expect(withStub).toEqual(withSys);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a leaf tsconfig.json that extends the root and adds its own paths alias", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-read-compiler-options-"));
    try {
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "esnext",
            module: "nodenext",
            moduleResolution: "nodenext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
        }),
      );
      mkdirSync(join(root, "packages", "leaf", "src"), { recursive: true });
      const leafConfigPath = join(root, "packages", "leaf", "tsconfig.json");
      writeFileSync(
        leafConfigPath,
        JSON.stringify({
          extends: "../../tsconfig.json",
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
          include: ["src/**/*", "index.ts"],
        }),
      );
      writeFileSync(join(root, "packages", "leaf", "src", "util.ts"), "export const util = 1;\n");
      writeFileSync(join(root, "packages", "leaf", "index.ts"), "export const value = 1;\n");

      const withSys = optionsFor(leafConfigPath, ts.sys);
      const withStub = optionsFor(leafConfigPath, noExpandHost);
      expect(withStub).toEqual(withSys);
      // The alias itself resolved (not silently dropped): the same
      // `pathsBasePath` (the leaf config's own directory, not the
      // project root) both calls compute.
      expect(withStub.paths).toEqual({ "@/*": ["./src/*"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
