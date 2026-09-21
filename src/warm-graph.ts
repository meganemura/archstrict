// Responsibility: reuse parsed and bound SourceFiles while resolving every import afresh on each refresh.
// An unchanged importer can lose a target, gain a previously missing target, or resolve to a new preferred target.
// SourceFile identity therefore cannot establish that its resolved edges are still correct.
// Boundary: no process, socket, daemon, or CLI integration; this object holds no resolved edges.
// Reuse does not establish the cost of type queries or end-to-end checks.
import ts from "typescript";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildModuleGraph, buildPreparedGraph, prepareGraph, graphBuildFingerprint,
  type BuildOptions, type ModuleGraph } from "./module-graph.js";

function mtime(path: string): number | undefined {
  try { return statSync(path).mtimeMs; }
  catch { return undefined; }
}

function cachingHost(program: ts.Program): ts.CompilerHost {
  const host = ts.createCompilerHost(program.getCompilerOptions());
  const cache = new Map<string, { mtimeMs: number; sourceFile: ts.SourceFile }>();
  for (const sourceFile of program.getSourceFiles()) {
    const mtimeMs = mtime(sourceFile.fileName);
    if (mtimeMs !== undefined) cache.set(resolve(sourceFile.fileName), { mtimeMs, sourceFile });
  }
  const getSourceFile = host.getSourceFile.bind(host);
  // The absolute path identifies the file; mtimeMs detects content changes without a read or hash of its contents.
  // A missing mtime cannot validate cached content. The underlying host must handle a deleted or inaccessible file with its normal behavior.
  host.getSourceFile = (fileName, ...args) => {
    const path = resolve(fileName);
    const mtimeMs = mtime(path);
    if (mtimeMs === undefined) return getSourceFile(fileName, ...args);
    const cached = cache.get(path);
    if (cached?.mtimeMs === mtimeMs) return cached.sourceFile;
    const sourceFile = getSourceFile(fileName, ...args);
    if (sourceFile !== undefined) cache.set(path, { mtimeMs, sourceFile });
    return sourceFile;
  };
  return host;
}

export function createWarmGraph(): { refresh(options: BuildOptions): ModuleGraph } {
  let held: { host: ts.CompilerHost; program: ts.Program; options: BuildOptions; fingerprint: string } | undefined;
  return {
    refresh(options) {
      const prepared = prepareGraph(options);
      // The CLI reads config afresh before each edge-cache lookup. This holder instead retains state across refresh calls.
      // The config mtime therefore provides a separate signal that the architecture config changed since the previous refresh.
      const fingerprint = JSON.stringify({ ...graphBuildFingerprint(options, prepared),
        configMtime: mtime(join(prepared.projectRoot, "archstrict.config.ts")) });
      // A changed fingerprint can mean new compiler options, package metadata, or module declarations, so the old host's assumptions are no longer valid.
      // Discard that host rather than patch it. Seed a new host from the cold Program to reuse only the newly established state.
      if (held === undefined || held.fingerprint !== fingerprint) {
        held = undefined;
        const graph = buildModuleGraph(options);
        held = { host: cachingHost(graph.program), program: graph.program, options, fingerprint };
        return graph;
      }
      // An importer can keep the same SourceFile while its target disappears, becomes available, or gives way to a preferred target.
      // Parsed source reuse remains valid, but a held resolution answer can become stale. A fresh cache prevents that error on every refresh.
      const resolutionCache = ts.createModuleResolutionCache(prepared.projectRoot,
        held.host.getCanonicalFileName.bind(held.host), prepared.compilerOptions);
      const graph = buildPreparedGraph(prepared, { host: held.host, oldProgram: held.program, resolutionCache });
      held = { ...held, program: graph.program, options };
      return graph;
    },
  };
}
