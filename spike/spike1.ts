// Spike 1 (archstrict-t35.1): does the TypeScript compiler API resolve
// imports and read module exports fast enough for v0's target, a few
// seconds for a few hundred files? Measured against nukadoko's src/
// (read-only; never modified), 182 files across 24 top-level directories,
// none of which have a public.ts. Two stages are timed separately, because
// they cost different things in the real checker: resolving every import
// (stage A, needed by every check) versus reading a module's exports
// (stage B, needed only for the inference hint and the future type-leak
// rule). A slow stage B must not read as a no-go for stage A's rules.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// A sibling checkout, or NUKADOKO_SRC for a different layout. Read-only:
// this spike never writes into it. Resolved to absolute: the compiler
// normalizes source file names to absolute paths, and a relative root here
// would silently fail every `rootNames.includes(sf.fileName)` comparison
// below (measured: 8 matches out of 182 with a relative root).
const NUKADOKO = resolve(process.env.NUKADOKO_SRC ?? join("..", "nukadoko"));
const SRC = join(NUKADOKO, "src");

function loadTsconfig(): ts.CompilerOptions {
  const configPath = join(NUKADOKO, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, (p) =>
    readFileSync(p, "utf8"),
  );
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, NUKADOKO);
  return parsed.options;
}

function moduleOf(filePath: string): string {
  const rel = relative(SRC, filePath);
  const [first] = rel.split("/");
  return first ?? rel;
}

function main(): void {
  const options = loadTsconfig();
  const rootNames = ts.sys
    .readDirectory(SRC, [".ts"])
    .filter((f) => !f.endsWith(".d.ts"));

  // ── Stage A: build the program, resolve every relative import/export ──
  const t0 = performance.now();
  const program = ts.createProgram({ rootNames, options });
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => rootNames.includes(sf.fileName));

  let crossModuleEdges = 0;
  let unresolvedSpecifiers = 0;
  const host = ts.createCompilerHost(options);

  for (const sf of sourceFiles) {
    const importerModule = moduleOf(sf.fileName);
    ts.forEachChild(sf, (node) => {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      }
      if (specifier === undefined || !ts.isStringLiteral(specifier)) return;
      if (!specifier.text.startsWith(".")) return; // package import, not a module edge
      const resolved = ts.resolveModuleName(
        specifier.text,
        sf.fileName,
        options,
        host,
      );
      const resolvedPath = resolved.resolvedModule?.resolvedFileName;
      if (resolvedPath === undefined) {
        unresolvedSpecifiers++;
        return;
      }
      const targetModule = moduleOf(resolvedPath);
      if (targetModule !== importerModule) crossModuleEdges++;
    });
  }
  const t1 = performance.now();

  // ── Stage B: read each file's exports through the checker ──────────────
  const t2 = performance.now();
  const checker = program.getTypeChecker();
  let exportsRead = 0;
  for (const sf of sourceFiles) {
    const symbol = checker.getSymbolAtLocation(sf);
    if (symbol === undefined) continue;
    exportsRead += checker.getExportsOfModule(symbol).length;
  }
  const t3 = performance.now();

  const modules = new Set(sourceFiles.map((sf) => moduleOf(sf.fileName)));
  const stageAMs = t1 - t0;
  const stageBMs = t3 - t2;
  const perFileBMs = stageBMs / sourceFiles.length;

  console.log(
    JSON.stringify(
      {
        files: sourceFiles.length,
        modules: modules.size,
        crossModuleEdges,
        unresolvedSpecifiers,
        exportsRead,
        stageA_resolveImports_ms: Math.round(stageAMs),
        stageB_getExportsOfModule_ms: Math.round(stageBMs),
        stageB_perFile_ms: Number(perFileBMs.toFixed(3)),
        stageB_extrapolated_for_24_public_ts_ms: Number(
          (perFileBMs * 24).toFixed(1),
        ),
      },
      null,
      2,
    ),
  );
}

main();
