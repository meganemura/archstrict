// Responsibility: store and validate a per-file, incrementally-updatable
// snapshot of each analyzed file's own syntactic import walk, module
// augmentations, and resolved specifiers. It also stores the narrower
// augmentation scan for resolvable TypeScript files outside analysis.
// Shards avoid whole-cache I/O.
// Boundary: cache failures fall back to analysis; this module never parses
// a file or resolves an import itself - module-graph.ts owns both, and
// hands this module only the results to persist or read back.
//
// On-disk layout: one header file (`edges.json`, at the path the caller
// passes) plus a fixed SHARD_COUNT of shard files beside it, under an
// `edges/` directory. A file's own shard is `shardIndexForRelativePath` of
// its path relative to the project root - stable across runs and across
// which files happen to exist, so a build only ever touches the shards
// whose own membership or content actually changed. The header records
// each shard's file name and a sha256 of its exact on-disk bytes; a reader
// that finds a shard missing, unreadable, or hash-mismatched treats only
// that shard's own files as a cache miss (re-walked and re-resolved by
// module-graph.ts's own per-file loop) - never the rest of the cache, and
// never an error.
//
// Each shard's own JSON is a compact encoding, not one object per file:
// a `paths` string table (each path stored relative to the project root,
// via node:path's own relative/resolve - reversible for a resolved file
// outside the root too, since path.relative can and does return a leading
// `..` segment for that case), a `specifiers` string table, a
// `packageNames` string table, and one array-of-indexes tuple per file
// (never an object keyed by that file's own path). Each file's own
// `resolutions` are encoded inline, aligned by position with that file's
// own `imports` (never as a second object keyed by specifier) - a `null`
// slot is exactly the imports this project's own walk never gives a
// resolutions entry to (a node builtin), not "unresolved" (which encodes
// as `0`, distinct from `null`).
//
// Correctness contract - every input that can change a resolved edge, and
// where it is covered:
// - A file's own text (syntax, imports, exports, `require(...)`, or the
//   augmentation scan of a non-analyzed TypeScript file) - covered by
//   that file's own mtimeMs+size (module-graph.ts's own reparse gate).
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
//   resolve to any of these. Existence is covered by
//   `resolutionFingerprint`'s own `resolvableFilesHash`. A non-analyzed
//   TypeScript file's augmentation syntax is covered by its own entry.
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
// - Which shard a given file's own entry landed in, and whether that
//   shard's own bytes on disk still match what this cache last wrote -
//   covered by the header's own per-shard content hash (above); a shard
//   whose file is missing or whose hash no longer matches contributes no
//   entries at all, which module-graph.ts's own per-file loop already
//   treats exactly like a brand-new file (no old entry -> reparse and
//   re-resolve), scoped to that one shard's own files.
// A file whose own reparse gate holds AND whose `resolutionFingerprint`
// still matches reuses its stored `resolutions` outright, with no
// `ts.resolveModuleName` call at all - the common, nothing-changed case a
// `check` hook run hits on every keystroke that isn't an import edit.
// A changed `resolutionFingerprint` alone (nothing in this file's own
// reparse gate) re-resolves every specifier project-wide, from each file's
// own already-cached `imports` - no file is reparsed just for that. Every
// analyzed file gets a resolution record for every one of its own
// specifiers, whether or not it currently belongs to a declared module,
// and a specifier with no record is resolved rather than assumed
// unresolved - see module-graph.ts's own per-file loop for why.
// `fromModule`/`toModule`/`externalPackage` are never stored here: they
// depend on the current `declaredModules` alone, which a graph build
// already has in hand for free, and storing them would mean invalidating
// this whole cache on every config edit instead of none.
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type ts from "typescript";
import type { ImportRecord, ModuleAugmentationSpecifier } from "./module-graph.js";

// Bumped whenever the on-disk shape (header or shard encoding) changes -
// an old cache is then a silent miss (parseHeader rejects the unknown
// schema number), never a crash on a shape this code no longer produces.
export const CACHE_SCHEMA = 9;

// Fixed, not derived from project size - see this module's own header.
// module-graph.ts's own per-file loop marks a shard dirty by this same
// function; both sides agree only because they share it.
export const SHARD_COUNT = 64;

export function shardIndexForRelativePath(relativePath: string): number {
  const digest = createHash("sha256").update(relativePath).digest();
  return digest.readUInt32BE(0) % SHARD_COUNT;
}

// Rebuilds an absolute path from a shard's own stored relative path, spelled
// the way TypeScript itself spells an absolute path (forward slashes, on
// every platform - ts.resolveModuleName's own resolvedFileName is never
// backslash-separated, even on Windows). node:path's own `resolve` restores
// the right path but, on Windows, with backslashes - left alone, a warm
// build's own `resolvedFile` would then spell the same file differently
// from a cold build's, breaking every downstream string comparison
// (`resolutions` keys, edge targets) that assumes one spelling. A no-op on
// POSIX, where `sep` is already "/".
function restoreAbsolutePath(projectRoot: string, relativePath: string): string {
  return resolve(projectRoot, relativePath).split(sep).join("/");
}

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
  hasModuleAugmentation: boolean;
  moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
  // A scan-only entry prevents an excluded file from masquerading as an
  // analyzed import walk if configuration later moves it into analysis.
  augmentationScanOnly: boolean;
  unreadable?: true;
  // Keyed by `${specifier}\u0000${mode ?? ""}` - two imports of the same
  // specifier under two different resolution modes (rare, but legal) must
  // not collide. On disk, this is never a specifier-keyed object (see this
  // module's own header) - only in memory, where module-graph.ts's own
  // per-file loop looks resolutions up by this same key.
  resolutions: Record<string, CachedResolution>;
};

export function resolutionKey(imp: Pick<ImportRecord, "specifier" | "mode">): string {
  return `${imp.specifier}\u0000${imp.mode ?? ""}`;
}

export type ShardHeaderEntry = { file: string; hash: string };

// The in-memory result of a successful read: every shard's own entries,
// merged into one map keyed by each file's own absolute path - and the
// header's own per-shard entries, threaded back into writeEdgeCache so an
// unchanged shard's own header line is copied forward rather than
// recomputed.
export type EdgeCache = {
  schema: typeof CACHE_SCHEMA;
  archstrictVersion: string;
  codeVersionHash: string;
  typescriptVersion: string;
  // Each distinct effective ts.CompilerOptions object, JSON-stringified
  // once - see this module's own header.
  optionsTable: string[];
  resolutionFingerprint: string;
  files: Record<string, CachedFileEntry>;
  shards: (ShardHeaderEntry | null)[];
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
function isModuleAugmentationSpecifier(value: unknown): value is ModuleAugmentationSpecifier {
  return record(value) && typeof value.specifier === "string" && isMode(value.mode);
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
  if (typeof value.isScript !== "boolean" || typeof value.hasAmbientDeclarations !== "boolean" ||
      typeof value.hasModuleAugmentation !== "boolean") return false;
  if (!Array.isArray(value.moduleAugmentationSpecifiers) ||
      !value.moduleAugmentationSpecifiers.every(isModuleAugmentationSpecifier) ||
      value.hasModuleAugmentation !== (value.moduleAugmentationSpecifiers.length > 0)) return false;
  if (typeof value.augmentationScanOnly !== "boolean") return false;
  if (value.unreadable !== undefined && value.unreadable !== true) return false;
  if (!record(value.resolutions) || !Object.values(value.resolutions).every(isResolution)) return false;
  return true;
}

type ParsedHeader = {
  archstrictVersion: string;
  codeVersionHash: string;
  typescriptVersion: string;
  optionsTable: string[];
  resolutionFingerprint: string;
  shards: (ShardHeaderEntry | null)[];
};

function isShardHeaderEntry(value: unknown): value is ShardHeaderEntry {
  return record(value) && typeof value.file === "string" && typeof value.hash === "string";
}

function parseHeader(value: unknown): ParsedHeader | undefined {
  if (!record(value) || value.schema !== CACHE_SCHEMA) return undefined;
  if (typeof value.archstrictVersion !== "string" || typeof value.codeVersionHash !== "string" ||
      typeof value.typescriptVersion !== "string" || !strings(value.optionsTable) ||
      typeof value.resolutionFingerprint !== "string") return undefined;
  if (!Array.isArray(value.shards) || value.shards.length !== SHARD_COUNT ||
      !value.shards.every((s) => s === null || isShardHeaderEntry(s))) return undefined;
  return {
    archstrictVersion: value.archstrictVersion, codeVersionHash: value.codeVersionHash,
    typescriptVersion: value.typescriptVersion, optionsTable: value.optionsTable,
    resolutionFingerprint: value.resolutionFingerprint, shards: value.shards as (ShardHeaderEntry | null)[],
  };
}

// One shard's own on-disk shape - see this module's own header for why
// each table exists and why a file's own record is a tuple, not an
// object. `EncodedResolution`: `null` is "no resolutions entry at all"
// (a node builtin - module-graph.ts's own per-file loop never gives one
// a key), `0` is `"unresolved"`, and the 3-tuple is a real resolution.
type EncodedResolution = null | 0 | [pathIndex: number, isExternalLibraryImport: 0 | 1, packageNameIndex: number | null];
type EncodedImport = [
  specifierIndex: number, line: number, column: number,
  isTypeOnly: 0 | 1, isDynamic: 0 | 1, mode: number | null,
  resolution: EncodedResolution,
];
type EncodedModuleAugmentation = [specifierIndex: number, mode: number | null];
type EncodedFileEntry = [
  pathIndex: number, mtimeMs: number, size: number, optionsIndex: number,
  impliedNodeFormat: number | null, unsupportedSyntaxCount: number, flags: number,
  imports: EncodedImport[], moduleAugmentations: EncodedModuleAugmentation[],
];
type EncodedShard = { paths: string[]; specifiers: string[]; packageNames: string[]; files: EncodedFileEntry[] };

const FLAG_IS_SCRIPT = 1;
const FLAG_HAS_AMBIENT_DECLARATIONS = 2;
const FLAG_UNREADABLE = 4;
const FLAG_HAS_MODULE_AUGMENTATION = 8;
const FLAG_AUGMENTATION_SCAN_ONLY = 16;

function makeStringTable() {
  const table: string[] = [];
  const indexByValue = new Map<string, number>();
  return { table, index: (value: string): number => {
    let idx = indexByValue.get(value);
    if (idx === undefined) { idx = table.length; table.push(value); indexByValue.set(value, idx); }
    return idx;
  } };
}

// One shard's own entries, sorted by relative path - deterministic bytes
// for the same content, so a rewrite that changes nothing produces the
// same hash (and so `writeEdgeCache` can tell "unchanged" from "changed"
// without a byte compare).
function encodeShard(entries: ReadonlyMap<string, CachedFileEntry>, projectRoot: string): EncodedShard {
  const paths = makeStringTable();
  const specifiers = makeStringTable();
  const packageNames = makeStringTable();
  const encodeResolution = (res: CachedResolution): EncodedResolution => {
    if (res === "unresolved") return 0;
    return [paths.index(relative(projectRoot, res.resolvedFile)), res.isExternalLibraryImport ? 1 : 0,
      res.packageName === undefined ? null : packageNames.index(res.packageName)];
  };
  const files: EncodedFileEntry[] = [];
  for (const relPath of [...entries.keys()].sort()) {
    const entry = entries.get(relPath)!;
    const flags = (entry.isScript ? FLAG_IS_SCRIPT : 0) | (entry.hasAmbientDeclarations ? FLAG_HAS_AMBIENT_DECLARATIONS : 0) |
      (entry.unreadable ? FLAG_UNREADABLE : 0) | (entry.hasModuleAugmentation ? FLAG_HAS_MODULE_AUGMENTATION : 0) |
      (entry.augmentationScanOnly ? FLAG_AUGMENTATION_SCAN_ONLY : 0);
    const encodedImports: EncodedImport[] = entry.imports.map((imp) => {
      const key = resolutionKey(imp);
      const res = Object.hasOwn(entry.resolutions, key) ? entry.resolutions[key] : undefined;
      return [
        specifiers.index(imp.specifier), imp.fromPosition.line, imp.fromPosition.column,
        imp.isTypeOnly ? 1 : 0, imp.isDynamic ? 1 : 0, imp.mode ?? null,
        res === undefined ? null : encodeResolution(res),
      ];
    });
    const encodedModuleAugmentations: EncodedModuleAugmentation[] = entry.moduleAugmentationSpecifiers.map(
      (augmentation) => [specifiers.index(augmentation.specifier), augmentation.mode ?? null],
    );
    files.push([
      paths.index(relPath), entry.mtimeMs, entry.size, entry.optionsIndex,
      entry.impliedNodeFormat ?? null, entry.unsupportedSyntaxCount, flags, encodedImports, encodedModuleAugmentations,
    ]);
  }
  return { paths: paths.table, specifiers: specifiers.table, packageNames: packageNames.table, files };
}

// The exact inverse of encodeShard - `undefined` means the shard's own
// JSON does not have this module's own shape (a version mismatch that
// slipped past the header's schema check, or a hand-edited file); the
// caller then drops the whole shard, never a single bad file inside it,
// matching the header's own hash check (also whole-shard).
function decodeShard(raw: unknown, projectRoot: string, optionsCount: number): Map<string, CachedFileEntry> | undefined {
  if (!record(raw)) return undefined;
  const { paths, specifiers, packageNames, files } = raw;
  if (!strings(paths) || !strings(specifiers) || !strings(packageNames) || !Array.isArray(files)) return undefined;
  const result = new Map<string, CachedFileEntry>();
  for (const tuple of files) {
    if (!Array.isArray(tuple) || tuple.length !== 9) return undefined;
    const [pathIdx, mtimeMs, size, optionsIndex, impliedRaw, unsupportedSyntaxCount, flags, importsRaw, augmentationsRaw] = tuple as unknown[];
    if (!Number.isInteger(pathIdx) || (pathIdx as number) < 0 || (pathIdx as number) >= paths.length) return undefined;
    if (!Number.isInteger(optionsIndex) || (optionsIndex as number) < 0 || (optionsIndex as number) >= optionsCount) return undefined;
    if (!isMode(impliedRaw === null ? undefined : impliedRaw)) return undefined;
    if (typeof flags !== "number") return undefined;
    if (!Array.isArray(importsRaw)) return undefined;
    if (!Array.isArray(augmentationsRaw)) return undefined;
    const imports: ImportRecord[] = [];
    const resolutions: Record<string, CachedResolution> = {};
    let ok = true;
    for (const impTuple of importsRaw) {
      if (!ok) break;
      if (!Array.isArray(impTuple) || impTuple.length !== 7) { ok = false; break; }
      const [specIdx, line, column, isTypeOnly, isDynamic, modeRaw, resRaw] = impTuple as unknown[];
      if (!Number.isInteger(specIdx) || (specIdx as number) < 0 || (specIdx as number) >= specifiers.length) { ok = false; break; }
      const mode = (modeRaw === null ? undefined : modeRaw) as ts.ResolutionMode;
      const imp: ImportRecord = {
        specifier: specifiers[specIdx as number]!,
        fromPosition: { line: line as number, column: column as number },
        isTypeOnly: isTypeOnly === 1, isDynamic: isDynamic === 1, mode,
      };
      if (!isImportRecord(imp)) { ok = false; break; }
      imports.push(imp);
      if (resRaw === null) continue;
      let resolution: CachedResolution | undefined;
      if (resRaw === 0) resolution = "unresolved";
      else if (Array.isArray(resRaw) && resRaw.length === 3) {
        const [resPathIdx, isExternal, packageNameIdx] = resRaw as unknown[];
        if (!Number.isInteger(resPathIdx) || (resPathIdx as number) < 0 || (resPathIdx as number) >= paths.length) { ok = false; break; }
        if (packageNameIdx !== null && (!Number.isInteger(packageNameIdx) || (packageNameIdx as number) < 0 || (packageNameIdx as number) >= packageNames.length)) { ok = false; break; }
        resolution = {
          resolvedFile: restoreAbsolutePath(projectRoot, paths[resPathIdx as number]!),
          ...(isExternal === 1 ? { isExternalLibraryImport: true as const } : {}),
          ...(packageNameIdx !== null ? { packageName: packageNames[packageNameIdx as number]! } : {}),
        };
      } else { ok = false; break; }
      if (!isResolution(resolution)) { ok = false; break; }
      resolutions[resolutionKey(imp)] = resolution;
    }
    if (!ok) return undefined;
    const moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[] = [];
    for (const augmentationTuple of augmentationsRaw) {
      if (!Array.isArray(augmentationTuple) || augmentationTuple.length !== 2) return undefined;
      const [specifierIdx, modeRaw] = augmentationTuple as unknown[];
      if (!Number.isInteger(specifierIdx) || (specifierIdx as number) < 0 ||
          (specifierIdx as number) >= specifiers.length || !isMode(modeRaw === null ? undefined : modeRaw)) return undefined;
      moduleAugmentationSpecifiers.push({
        specifier: specifiers[specifierIdx as number]!,
        mode: (modeRaw === null ? undefined : modeRaw) as ts.ResolutionMode,
      });
    }
    const entry: CachedFileEntry = {
      mtimeMs: mtimeMs as number, size: size as number, optionsIndex: optionsIndex as number,
      ...(impliedRaw !== null ? { impliedNodeFormat: impliedRaw as ts.ResolutionMode } : {}),
      imports, unsupportedSyntaxCount: unsupportedSyntaxCount as number,
      isScript: ((flags as number) & FLAG_IS_SCRIPT) !== 0,
      hasAmbientDeclarations: ((flags as number) & FLAG_HAS_AMBIENT_DECLARATIONS) !== 0,
      hasModuleAugmentation: ((flags as number) & FLAG_HAS_MODULE_AUGMENTATION) !== 0,
      moduleAugmentationSpecifiers,
      augmentationScanOnly: ((flags as number) & FLAG_AUGMENTATION_SCAN_ONLY) !== 0,
      ...(((flags as number) & FLAG_UNREADABLE) !== 0 ? { unreadable: true as const } : {}),
      resolutions,
    };
    if (!isFileEntry(entry)) return undefined;
    result.set(restoreAbsolutePath(projectRoot, paths[pathIdx as number]!), entry);
  }
  return result;
}

// Reads the header, then each shard it names, one at a time - never the
// whole cache as one string (this module's own header). A shard that is
// missing, hash-mismatched, or fails to decode contributes no entries and
// is never an error; the header itself failing to parse (an unknown
// schema, or any other malformed shape) is the one case that misses the
// whole cache.
export function readEdgeCache(path: string, projectRoot: string): EdgeCache | undefined {
  let headerRaw: unknown;
  try { headerRaw = JSON.parse(readFileSync(path).toString("utf8")); } catch { return undefined; }
  const header = parseHeader(headerRaw);
  if (header === undefined) return undefined;
  const dir = dirname(path);
  const files: Record<string, CachedFileEntry> = {};
  for (const shardEntry of header.shards) {
    if (shardEntry === null) continue;
    let buf: Buffer;
    try { buf = readFileSync(join(dir, shardEntry.file)); } catch { continue; }
    if (createHash("sha256").update(buf).digest("hex") !== shardEntry.hash) continue;
    let raw: unknown;
    try { raw = JSON.parse(buf.toString("utf8")); } catch { continue; }
    const decoded = decodeShard(raw, projectRoot, header.optionsTable.length);
    if (decoded === undefined) continue;
    for (const [absPath, entry] of decoded) files[absPath] = entry;
  }
  return {
    schema: CACHE_SCHEMA, archstrictVersion: header.archstrictVersion, codeVersionHash: header.codeVersionHash,
    typescriptVersion: header.typescriptVersion, optionsTable: header.optionsTable,
    resolutionFingerprint: header.resolutionFingerprint, files, shards: header.shards,
  };
}

// Writes only the shards that actually need it, then the header last (so
// a process killed mid-write leaves the header pointing at shards that
// are each internally consistent, never a header naming a shard this
// write never finished).
//
// `forceAll`: true the moment `archstrictVersion`/`codeVersionHash`/
// `typescriptVersion` mismatched, or the resolution fingerprint moved -
// either one can change every file's own entry, so every shard that has
// any current file is rewritten regardless of `dirtyPaths`.
// `dirtyPaths`/`deletedPaths`: every file whose own entry changed this
// build (reparsed or re-resolved) or disappeared - each marks its own
// shard for a rewrite; every other shard's own header line is copied
// forward from `oldShards` untouched (no read of its own bytes, no
// rewrite).
export function writeEdgeCache(
  path: string,
  projectRoot: string,
  cache: {
    archstrictVersion: string; codeVersionHash: string; typescriptVersion: string;
    optionsTable: string[]; resolutionFingerprint: string; files: Record<string, CachedFileEntry>;
  },
  oldShards: readonly (ShardHeaderEntry | null)[] | undefined,
  dirtyPaths: ReadonlySet<string>,
  deletedPaths: ReadonlySet<string>,
  forceAll: boolean,
): void {
  const dir = dirname(path);
  const shardsDir = join(dir, "edges");
  const groups = new Map<number, Map<string, CachedFileEntry>>();
  for (const [absPath, entry] of Object.entries(cache.files)) {
    const relPath = relative(projectRoot, absPath);
    const idx = shardIndexForRelativePath(relPath);
    let group = groups.get(idx);
    if (group === undefined) { group = new Map(); groups.set(idx, group); }
    group.set(relPath, entry);
  }
  const dirtyShards = new Set<number>();
  for (const absPath of dirtyPaths) dirtyShards.add(shardIndexForRelativePath(relative(projectRoot, absPath)));
  for (const absPath of deletedPaths) dirtyShards.add(shardIndexForRelativePath(relative(projectRoot, absPath)));

  try { mkdirSync(shardsDir, { recursive: true }); } catch { /* best-effort; each shard write below no-ops on failure too */ }

  const shards: (ShardHeaderEntry | null)[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const group = groups.get(i);
    if (group === undefined) { shards.push(null); continue; }
    const oldEntry = oldShards?.[i] ?? null;
    // A group with files but no prior header line can only happen for a
    // shard this build must write anyway (forceAll, or every one of its
    // files freshly dirty) - defended here too, so a bug in that
    // reasoning loses no data silently.
    const mustRewrite = forceAll || dirtyShards.has(i) || oldEntry === null;
    if (!mustRewrite) { shards.push(oldEntry); continue; }
    const file = `edges/${i}.json`;
    const json = JSON.stringify(encodeShard(group, projectRoot));
    const hash = createHash("sha256").update(json).digest("hex");
    const fullPath = join(dir, file);
    const temporary = `${fullPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, json, { flag: "wx" });
      renameSync(temporary, fullPath);
      shards.push({ file, hash });
    } catch {
      // A read-only shard directory must not prevent a fresh analysis
      // result - the next successful write replaces this line too.
      shards.push(null);
    } finally {
      try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup on read-only filesystems */ }
    }
  }

  const header = {
    schema: CACHE_SCHEMA, archstrictVersion: cache.archstrictVersion, codeVersionHash: cache.codeVersionHash,
    typescriptVersion: cache.typescriptVersion, optionsTable: cache.optionsTable,
    resolutionFingerprint: cache.resolutionFingerprint, shards,
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, JSON.stringify(header), { flag: "wx" });
    renameSync(temporary, path);
  } catch {
    // A read-only cache directory must not prevent a fresh analysis result.
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup on read-only filesystems */ }
  }
}
