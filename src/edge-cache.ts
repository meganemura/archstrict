// Responsibility: store and validate a per-file, incrementally-updatable
// snapshot of each analyzed file's own syntactic import walk and resolved
// specifiers.
// Boundary: cache failures fall back to analysis; this module never parses
// a file or resolves an import itself - module-graph.ts owns both, and
// hands this module only the results to persist or read back.
//
// Correctness contract - every input that can change a resolved edge, and
// where it is covered:
// - A file's own text (syntax, imports, exports, `require(...)`) - covered
//   by that file's own mtimeMs+size (module-graph.ts's own reparse gate).
//   Limit: an edit that keeps the exact same byte size AND whose mtime is
//   restored (or never advances - some filesystems and some tools truncate
//   mtime precision) is invisible to this gate; nothing else in this
//   fingerprint covers it either.
// - The nearest package.json "type" a file resolves under (decides
//   ESM-vs-CJS `impliedNodeFormat`, which each of that file's own imports'
//   `mode` is derived from) - covered by each file's own `impliedNodeFormat`
//   field, recomputed every build with no parse needed
//   (ts.getImpliedNodeFormatForFile reads only package.json), and compared
//   against the stored value.
// - The nearest tsconfig's own effective compiler options (module,
//   moduleResolution, paths, ...) - covered by each file's own
//   `optionsIndex` into `optionsTable` below, recomputed every build the
//   same cheap way (module-graph.ts's own per-directory
//   `compilerOptionsForFile` cache) and compared against the stored value.
//   A file whose `impliedNodeFormat` or `optionsIndex` changed is reparsed
//   exactly like a file whose own text changed, without dropping the whole
//   cache.
// - Which files are analyzed at all (a file added, deleted, or renamed) -
//   covered by `resolutionFingerprint`'s own `filesHash`, the sorted
//   analyzed-file list hashed once, not embedded per file. A file moving
//   into or out of a declared module is a different input: `filesHash`
//   does not move for it (the file was already analyzed either way) -
//   covered instead by each file's own per-specifier resolution record,
//   resolved (never assumed unresolved) the moment a record is missing
//   for a specifier this build now has a reason to ask about - see
//   module-graph.ts's own per-file loop.
// - Every package.json under the project root outside node_modules (its
//   own `exports`/`imports` map, or a plain `main`/`type`) - covered by
//   `resolutionFingerprint`'s own `packages` map (path -> mtime).
// - Every file outside node_modules with a resolvable extension
//   (.ts/.tsx/.mts/.cts/.d.ts/.d.mts/.d.cts/.js/.mjs/.cjs/.jsx/.json),
//   analyzed or not, excluded or not, in dist/ or not - a specifier can
//   resolve to any of these, and only its existence (never its content)
//   matters - covered by `resolutionFingerprint`'s own
//   `resolvableFilesHash`.
// - The lockfile in use (which real dependency version - and so which
//   real files - a bare specifier resolves to) - covered by
//   `resolutionFingerprint`'s own `lockPath`/`lockMtime`, the nearest
//   lockfile found at the project root or any ancestor directory.
// - Every node_modules directory on the path module resolution actually
//   walks (the project root's own, and each ancestor's, up to the nearest
//   lockfile's own directory or the filesystem root) - covered by
//   `resolutionFingerprint`'s own `nodeModules` map, one entry per such
//   directory, each a map of top-level package name to that package's own
//   package.json mtime (read after following a symlink, so `npm link` and
//   a workspace's own symlinked sibling both count). Limit: an edit made
//   directly to an already-installed package's own file (not its
//   package.json) is invisible to this map, and to every other input this
//   fingerprint reads - deleting node_modules/.cache/archstrict is the
//   only way to force a rebuild for that case.
// - Every distinct effective compiler-options object across the project -
//   covered by `optionsTable` (hashed once per distinct object, not once
//   per file) folded into `resolutionFingerprint`.
// - This project's own built code (module-graph.js, edge-cache.js) and
//   the installed typescript's own version - a local build with a
//   changed walker or resolver, or a different typescript resolving the
//   same specifiers differently, produces entries the old combination
//   never would have; covered by `codeVersionHash` and `typescriptVersion`,
//   together with `archstrictVersion`, any one mismatch dropping the
//   whole cache.
// A file whose own reparse gate holds AND whose `resolutionFingerprint`
// still matches reuses its stored `resolutions` outright, with no
// `ts.resolveModuleName` call at all - the common, nothing-changed case a
// `check` hook run hits on every keystroke that isn't an import edit.
// A changed `resolutionFingerprint` alone (nothing in this file's own
// reparse gate) re-resolves every specifier project-wide, from each file's
// own already-cached `imports` - no file is reparsed just for that. Every
// walked file gets a resolution record for every one of its own
// specifiers, whether or not it currently belongs to a declared module,
// and a specifier with no record is resolved rather than assumed
// unresolved - see module-graph.ts's own per-file loop for why.
// `fromModule`/`toModule`/`externalPackage` are never stored here: they
// depend on the current `declaredModules` alone, which a graph build
// already has in hand for free, and storing them would mean invalidating
// this whole cache on every config edit instead of none.
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type ts from "typescript";
import type { ImportRecord } from "./module-graph.js";

// The raw fact a resolved specifier needs preserved across builds - never
// `fromModule`/`toModule`/`externalPackage` (see this module's own header).
// `"unresolved"` mirrors a fresh walk's own outcome for the same specifier
// (module-graph.ts pushes it onto `unresolvedSpecifiers` either way).
export type CachedResolution =
  | { resolvedFile: string; isExternalLibraryImport?: true; packageName?: string }
  | "unresolved";

export type CachedFileEntry = {
  mtimeMs: number;
  size: number;
  // Index into the cache's own `optionsTable` - see this module's header.
  optionsIndex: number;
  // ts.ResolutionMode (ModuleKind.CommonJS | ModuleKind.ESNext), omitted
  // (JSON drops an `undefined` property) under a resolution strategy that
  // does not vary by usage - see ImportRecord's own comment for why this
  // is the same shape as each import's own `mode`.
  impliedNodeFormat?: ts.ResolutionMode;
  imports: ImportRecord[];
  unsupportedSyntaxCount: number;
  isScript: boolean;
  hasAmbientDeclarations: boolean;
  unreadable?: true;
  // Keyed by `${specifier}\u0000${mode ?? ""}` - two imports of the same
  // specifier under two different resolution modes (rare, but legal) must
  // not collide.
  resolutions: Record<string, CachedResolution>;
};

export type EdgeCache = {
  schema: 5;
  archstrictVersion: string;
  codeVersionHash: string;
  typescriptVersion: string;
  // Each distinct effective ts.CompilerOptions object, JSON-stringified
  // once - see this module's own header.
  optionsTable: string[];
  resolutionFingerprint: string;
  files: Record<string, CachedFileEntry>;
  // Directory-scan order, including a file with no edges.
  sourceOrder: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isMode(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
}
function isImportRecord(value: unknown): value is ImportRecord {
  if (!record(value) || !record(value.fromPosition)) return false;
  return typeof value.specifier === "string" && typeof value.isTypeOnly === "boolean" && typeof value.isDynamic === "boolean" &&
    isMode(value.mode) &&
    [value.fromPosition.line, value.fromPosition.column].every((n) => Number.isInteger(n) && Number(n) > 0);
}
function isResolution(value: unknown): value is CachedResolution {
  if (value === "unresolved") return true;
  return record(value) && typeof value.resolvedFile === "string" &&
    (value.isExternalLibraryImport === undefined || value.isExternalLibraryImport === true) &&
    (value.packageName === undefined || typeof value.packageName === "string");
}
function isFileEntry(value: unknown): value is CachedFileEntry {
  if (!record(value)) return false;
  if (typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs)) return false;
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) return false;
  if (!Number.isInteger(value.optionsIndex) || Number(value.optionsIndex) < 0) return false;
  if (!isMode(value.impliedNodeFormat)) return false;
  if (!Array.isArray(value.imports) || !value.imports.every(isImportRecord)) return false;
  if (!Number.isInteger(value.unsupportedSyntaxCount) || Number(value.unsupportedSyntaxCount) < 0) return false;
  if (typeof value.isScript !== "boolean" || typeof value.hasAmbientDeclarations !== "boolean") return false;
  if (value.unreadable !== undefined && value.unreadable !== true) return false;
  if (!record(value.resolutions) || !Object.values(value.resolutions).every(isResolution)) return false;
  return true;
}

export function readEdgeCache(path: string): EdgeCache | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || value.schema !== 5 || typeof value.archstrictVersion !== "string" ||
        typeof value.codeVersionHash !== "string" || typeof value.typescriptVersion !== "string" ||
        !strings(value.optionsTable) || typeof value.resolutionFingerprint !== "string" ||
        !record(value.files) || !strings(value.sourceOrder)) return undefined;
    const optionsCount = value.optionsTable.length;
    for (const entry of Object.values(value.files)) {
      if (!isFileEntry(entry)) return undefined;
      if (entry.optionsIndex >= optionsCount) return undefined;
    }
    if (value.sourceOrder.length !== Object.keys(value.files).length ||
        new Set(value.sourceOrder).size !== value.sourceOrder.length ||
        value.sourceOrder.some((file) => !Object.hasOwn(value.files as object, file))) return undefined;
    return value as EdgeCache;
  } catch {
    // A corrupt or unreadable cache file is a silent miss, never an error
    // - the next successful build's own write replaces it.
    return undefined;
  }
}

export function writeEdgeCache(path: string, cache: EdgeCache): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(cache), { flag: "wx" });
    renameSync(temporary, path);
  } catch {
    // A read-only cache directory must not prevent a fresh analysis result.
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup on read-only filesystems. */ }
  }
}
