// Responsibility: across repeated refresh calls in one long-lived process
// (the MCP server's check tool, and fix's apply-and-recheck loop), skip re-parsing a file whose
// content hasn't changed while resolving every specifier afresh - a
// resolution answer can go stale even when the importing file itself has
// not (an unrelated file elsewhere gaining, losing, or reordering a
// preferred target).
// Boundary: no process, socket, daemon, or CLI integration; this object
// holds no resolved edges, no ts.Program, and no parsed AST of any kind
// across calls - only each file's own small, syntactic import list. A
// refresh whose graph a caller then asks for `program`/`checker` (an MCP
// `check` call, unless it is scoped to a non-surface file; also search,
// fix)
// builds a whole-project ts.Program fresh, every time, and drops it again
// at the end of that one refresh - a real, paid cost each time rule 6
// runs, kept bounded (module-graph.ts's own header: a whole-project
// Program's own parsed SourceFile/Node trees are what dominate memory on
// a large codebase) by never carrying that Program into the next refresh.
import ts from "typescript";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPreparedGraph, prepareGraph, graphBuildFingerprint, parseFileForImports,
  type BuildOptions, type FileImportWalk, type ModuleGraph } from "./module-graph.js";

function mtime(path: string): number | undefined {
  try { return statSync(path).mtimeMs; }
  catch { return undefined; }
}

export function createWarmGraph(): { refresh(options: BuildOptions): ModuleGraph } {
  // Keyed by absolute file path; holds the file's own syntactic import
  // list (never its AST - see this module's own header) plus the mtime
  // it was parsed at. A cache hit skips ts.createSourceFile and the
  // import walk entirely; resolution still runs for every import record,
  // hit or miss (module-graph.ts's own buildPreparedGraph does that part,
  // outside this cache).
  const cache = new Map<string, { mtimeMs: number; walk: FileImportWalk }>();
  let fingerprint: string | undefined;
  return {
    refresh(options) {
      const prepared = prepareGraph(options);
      // The CLI reads config afresh before each edge-cache lookup. This holder instead retains state across refresh calls.
      // The config mtime therefore provides a separate signal that the architecture config changed since the previous refresh.
      const currentFingerprint = JSON.stringify({ ...graphBuildFingerprint(options, prepared),
        configMtime: mtime(join(prepared.projectRoot, "archstrict.config.ts")) });
      // A changed fingerprint can mean new compiler options or package
      // metadata - a parse cached under the old options (module kind,
      // jsx setting, ...) is not safe to reuse under the new ones.
      if (fingerprint !== currentFingerprint) {
        cache.clear();
        fingerprint = currentFingerprint;
      }
      const host = ts.createCompilerHost(prepared.compilerOptions);
      const languageVersion = prepared.compilerOptions.target ?? ts.ScriptTarget.ESNext;
      // One package.json lookup cache per refresh: a cold refresh parses
      // every file, and each .ts/.tsx file's format depends on its nearest
      // package.json "type". Without it, every file re-reads each
      // package.json up its directory chain.
      const packageJsonInfoCache = ts.createModuleResolutionCache(prepared.projectRoot,
        host.getCanonicalFileName.bind(host), prepared.compilerOptions).getPackageJsonInfoCache();
      const fileWalk = (fileName: string): FileImportWalk | undefined => {
        const path = resolve(fileName);
        const mtimeMs = mtime(path);
        if (mtimeMs === undefined) return undefined;
        const cached = cache.get(path);
        if (cached?.mtimeMs === mtimeMs) return cached.walk;
        const text = host.readFile(fileName);
        if (text === undefined) return undefined;
        const walk = parseFileForImports(fileName, text, languageVersion, host, prepared.compilerOptionsForFile(fileName), packageJsonInfoCache);
        cache.set(path, { mtimeMs, walk });
        return walk;
      };
      // No oldProgram, no held host reused as a Program-building host
      // across calls: this refresh's graph builds its own Program (if
      // anything asks for `program`/`checker` at all) from scratch, and
      // that Program is this refresh's own business alone.
      return buildPreparedGraph(prepared, { host, fileWalk });
    },
  };
}
