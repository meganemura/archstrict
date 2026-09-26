// Responsibility: build every declared module's own file membership and
// resolve every import/export/dynamic-import edge to its target module.
// This is shared infrastructure: every rule (public-surface bypass,
// cycles, uncovered modules, deprecated edges) and every verb reads the
// same graph rather than each re-walking the source.
// Boundary: no rule logic here. A rule is a predicate over this graph's
// edges and modules; this module only builds the graph and says what it
// could not analyze (unresolved specifiers, unsupported syntax, files
// outside the modules glob) as counts, never as silence.
//
// Edges never require a whole-project ts.Program. A per-file
// ts.createSourceFile (parsed, walked for its own imports/exports, then
// dropped) does the same work a Program's own getSourceFiles() walk did,
// at a fraction of the memory: a Program's own parsed SourceFile/Node
// trees are what dominate memory on a codebase of tens of thousands of
// files, and archstrict's own edge records are a rounding error beside
// them (measured directly: dropping the Program after the edge walk on a
// 21,000-file tree returned the heap to a few tens of megabytes). A
// ts.Program is still built - lazily, only when a rule that needs real
// type information (rule 6, type-leak; search; fix; simulate) actually
// asks for `program` or `checker` - and can be released again once that
// rule is done with it (`releaseProgram`), rather than held for the rest
// of a run that no longer needs it.
//
// Every edge is tagged `isTypeOnly`. Decisions a downstream rule must not
// reopen: rule 1 (public-surface bypass) counts a type-only edge the same
// as a value edge — reaching an internal file for its types alone is still
// reaching past the public surface. Rule 2 (cycles) does NOT count a
// type-only edge — a type-only cycle has no runtime consequence, and TS
// itself allows it; counting it would produce violations nobody can act on.
//
// `unsupportedSyntaxCount` covers `require(...)` calls and
// `import x = require(...)`; under `verbatimModuleSyntax` (this project's
// own tsconfig, and the convention it targets) TS itself already rejects
// the latter as a syntax error, so in practice this count is driven by the
// former.
import ts from "typescript";
import { createHash } from "node:crypto";
import { readEdgeCache, writeEdgeCache, type EdgeCache } from "./edge-cache.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { builtinModules } from "node:module";
import { compileGlob, mostSpecificMatch } from "./classify.js";

// A node builtin (`fs`, `node:fs`, ...) never has a real resolvedModule:
// ts.resolveModuleName looks for an actual file, but @types/node's ambient
// `declare module "node:fs"` is resolved by the checker's own ambient-module
// lookup, a different mechanism entirely - resolveModuleName returns
// undefined for a builtin even with `types: ["node"]` set (measured
// directly, not assumed). Treating that as "unresolved" would flag nearly
// every backend project's own node:fs/node:path imports as unanalyzable.
// Detected once here, not resolved: a builtin is synthesized as its own
// external edge instead.
const BUILTIN_MODULE_NAMES = new Set(builtinModules);
function builtinModuleName(specifier: string): string | undefined {
  const bare = specifier.replace(/^node:/, "");
  return BUILTIN_MODULE_NAMES.has(bare) ? bare : undefined;
}

export type Position = { line: number; column: number };

export type Edge = {
  fromFile: string;
  fromModule: string;
  fromPosition: Position;
  specifier: string;
  isTypeOnly: boolean;
  // A dynamic `import(...)` call, not a static import/export declaration -
  // e.g. Nx's own enforce-module-boundaries treats a lazy-loaded edge
  // differently from a static one. Always false for a type-only edge (a
  // dynamic import is itself always a value expression; TypeScript has no
  // "import type(...)" call form).
  isDynamic: boolean;
  resolvedFile: string;
  toModule: string | undefined; // undefined when resolvedFile is outside every module (e.g. a package, or an outside-glob file)
  // Set when the resolved file is a genuine external dependency (a real
  // npm package TS resolves through node_modules - TS flags this
  // `isExternalLibraryImport`) whose real target file is NOT itself
  // inside this project. A leading "node:" is stripped so `import "fs"`
  // and `import "node:fs"` name the same package. This is the raw fact a
  // later rule synthesizes a `pkg:` tag from - this module does not
  // itself know about tags.
  //
  // Undefined for a workspace-sibling import too, even though TS also
  // marks that `isExternalLibraryImport` (a monorepo's own package
  // symlinked into node_modules resolves exactly like a real dependency
  // does) - see `isWorkspaceSiblingResolution`'s own comment for how that
  // case is told apart from a genuine external one. When it is, the
  // edge's target gets this project's own `classify` tags instead of a
  // synthesized `pkg:` one.
  externalPackage: string | undefined;
};

export type Module = {
  name: string;
  // The glob's literal prefix. A directory glob's prefix is that
  // directory. A glob that names one file (`src/index.ts`) keeps the file
  // here — surface and friends still resolve against the file's parent
  // (moduleRelativeDir), but widening `dir` to that parent would make a
  // type-leak boundary cover every sibling, and would make two file
  // modules in one directory share one root.
  dir: string;
  // True when `dir` is a file. Rules that phrase a fix as "add a file to
  // <module>/" must not assume a directory in that case.
  rootIsFile: boolean;
  files: string[];
  // The module's public surface: the files other modules may import from.
  // `surface` is itself a glob, so this can be more than one file (Prisma's
  // package.json `exports` has subpaths) - sorted, for a deterministic
  // message when a rule names "the" surface file.
  surfaceFiles: string[];
  // This module's own configured surface name/glob (or array of them) -
  // rule 1's own message used to name the graph's global default here
  // instead, wrong whenever a specific module overrides it (a real,
  // measured case: a package whose own surface is "types.d.ts", not the
  // project's own default). Carried in its original, un-normalized form -
  // display formatting (singular vs. plural) is rule 1's own job.
  surfaceName: string | readonly string[];
  // Rule 1's own "friend" exception - `fileGlob` is a project-relative
  // glob (resolved from the config's own module-relative `file`, the same
  // way `surfaceFiles` resolves `surface`), public to exactly the
  // importers `from` matches. Unlike `surfaceFiles`, this is never
  // resolved to a concrete file list here: rule 1 compiles both globs
  // itself, against the one specific edge it's judging, since a friend
  // exception's `from` side needs the same per-edge glob test `surface`
  // never does.
  friends: { fileGlob: string; from: string; because: string }[];
};

// A module declared directly in config - a barrel index.ts's mere presence
// is never taken as evidence of an enforced boundary (measured wrong:
// NestJS's and Drizzle's own barrel index.ts files are not operated as
// enforced boundaries; real code in both bypasses them routinely). `surface`
// is a glob resolved relative to `glob`'s own literal base directory
// (moduleGlobBaseDir below), not the project root - so it names a file
// relative to the module's own directory.
export type DeclaredModule = {
  name: string;
  glob: string;
  // A single glob, or several - a real package can publish more than one
  // real, differently-shaped public entry point at once (a package.json
  // `exports` map naming several real paths, not just its default `main`).
  // Optional: when absent, a real package.json's own exports map (if one
  // sits at this module's own root) is derived back to source at graph-
  // build time instead of being hand-transcribed - falling back to the
  // project's own global default when there's no exports map, or even
  // one entry in it can't be confidently resolved to a real source file.
  surface?: string | readonly string[];
  friends?: readonly { file: string; from: string; because: string }[];
};

export type ModuleGraph = {
  modules: Map<string, Module>;
  edges: Edge[];
  crossModuleEdges: Edge[];
  outsideFiles: string[]; // .ts files under the project root that match no module
  nonTsSourceFileCount: number; // files outside TypeScript analysis; a visibility count, not a violation
  unsupportedSyntaxCount: number; // require(), import x = require(...): out of scope for v0
  unresolvedSpecifierCount: number;
  // The raw specifier text of every unresolved import, in encounter order -
  // a bare count alone gave no way to tell "one specifier, many uses" from
  // "many distinct specifiers," which cost real diagnosis time tracking down
  // a missing tsconfig paths entry in a large monorepo (measured directly,
  // authoring a config against nrwl/nx's own packages/). check.ts derives a
  // by-prefix breakdown from this list rather than duplicating the walk.
  unresolvedSpecifiers: string[];
  // The configured public-surface file name(s) (e.g. "index.ts", or
  // DEFAULT_SURFACE's own array), carried on the graph so a rule can name
  // it in a message without needing the whole Config passed in just for
  // this one value.
  surface: string | readonly string[];
  // The realpath'd project root - rule 6 (type leak) needs it as the
  // boundary a declaration must fall inside to count as internal (a
  // dependency's own types, under node_modules, are not this project's
  // boundary to keep).
  rootDir: string;
  // The program and checker built over every module file - shared here so
  // a rule needing type information (rule 6) does not build its own
  // second program over the same files. Lazy: building either one parses
  // and binds every file in the program, the memory cost this module's
  // own edge build exists to avoid paying unconditionally (see this
  // module's own header) - so nothing on the edge path may touch either
  // getter, and a caller that never needs type information never pays for
  // a Program at all.
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  // Drops the memoized Program (and, with it, the checker) once a caller
  // that needed one (rule 6, search, fix) is done with it, so it does not
  // sit in memory for the rest of a run that has no further use for it. A
  // later access to `program`/`checker` builds a fresh one.
  releaseProgram(): void;
};

export type BuildOptions = {
  // simulate must adjust the disk file list before buildDeclaredModules
  // derives module metadata. All consumers then use metadata consistent
  // with that list, without a second, manually constructed prepared object.
  fileListOverride?: (realFiles: string[]) => string[];
  projectRoot: string;
  // The global default public-surface file name(s), default DEFAULT_SURFACE
  // below. A single string, or several - the same array-vs-string shape a
  // per-module `surface` already carries (surfaceGlobsFor's own entries
  // normalization already treats a bare string as a one-entry array).
  surface?: string | readonly string[];
  declaredModules: readonly DeclaredModule[];
  // Glob patterns excluded from the file scan entirely - config.exclude. A
  // file matching any one pattern is invisible to every rule, not just
  // uncounted: it is not a module member, not a source of edges, not a
  // target either.
  exclude?: readonly string[];
};

// Every TypeScript source extension archstrict analyzes - .tsx and
// .mts/.cts included, since limiting the walk to plain .ts silently
// dropped a whole React codebase's own UI code (a real, measured survey:
// 5 of 50 popular TypeScript repos have more .tsx than .ts). A hand-
// authored .d.ts/.d.mts/.d.cts stays excluded by default regardless (see
// isEligibleSourceFile's own comment) - this list is source extensions
// only, not every extension ts.sys.readDirectory could be asked for.
export const ANALYZED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

// The default public surface now names one file per analyzed source
// extension (an array, not a single string) - a directory module whose
// real entry point is index.tsx (a React project) or index.mts/index.cts
// must be found by the SAME default a plain index.ts project already
// gets, with no per-project config needed just to declare that.
export const DEFAULT_SURFACE: readonly string[] = ["index.ts", "index.tsx", "index.mts", "index.cts"];

// True for a hand-authored declaration file of ANY analyzed source
// extension (.d.ts, .d.mts, .d.cts) - the single pattern every
// declaration-file check below shares, so widening the analyzed source
// extensions never has to widen this check in more than one place.
function isDeclarationFile(file: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/.test(file);
}

// The literal directory prefix a glob names before its first wildcard,
// trailing slash stripped - "packages/x/**" -> "packages/x". `surface` is
// resolved relative to this.
// Exported: init's own fresh-run walk and a re-run's anchor computation
// both need the same literal-prefix rule a declared module's glob already
// follows, so a directory group's glob (e.g. "src/extra/**") and a
// project's own existing declaredModules entries agree on what "the
// module's own directory" means.
export function moduleGlobBaseDir(glob: string): string {
  const firstWildcard = glob.search(/\*/);
  const prefix = firstWildcard === -1 ? glob : glob.slice(0, firstWildcard);
  return prefix.replace(/\/+$/, "");
}

function pathIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Directory a module-relative path (surface, friends) resolves against.
// A glob with no wildcard that names an existing file has no directory of
// its own. Those paths resolve against the file's parent, so
// `{ glob: "src/index.ts", surface: "index.ts" }` names `src/index.ts`
// and not `src/index.ts/index.ts`. The parent is computed with string
// ops, not `path.dirname`: globs are project-relative posix even on
// Windows, and `path.dirname` would follow the platform separator.
function moduleRelativeDir(projectRoot: string, glob: string): string {
  const base = moduleGlobBaseDir(glob);
  if (!pathIsFile(join(projectRoot, base))) return base;
  const slash = base.lastIndexOf("/");
  return slash === -1 ? "" : base.slice(0, slash);
}

function moduleRelativeGlob(projectRoot: string, glob: string, relativePath: string): string {
  const base = moduleRelativeDir(projectRoot, glob);
  const joined = base === "" ? relativePath : `${base}/${relativePath}`;
  return joined.replace(/\/{2,}/g, "/").replace(/^\//, "");
}

export function toProjectRelativePosix(filePath: string, projectRoot: string): string {
  return relative(projectRoot, filePath).split(sep).join("/");
}

// Recursively lists every .ts file under `projectRoot`, excluding
// node_modules, dist, and every config.exclude glob - the candidate set
// declared-module membership and surface matching both filter from.
// Declared modules can live anywhere under the project, so there is no
// narrower directory to start from than the project root itself.
// True when a `resolvedFileName` TS itself flagged `isExternalLibraryImport`
// (per that field's own contract: "comes from node_modules") is actually a
// workspace's own sibling package - a package manager symlinks a sibling
// package into node_modules exactly like a real dependency, but following
// that symlink lands back on a real file this project owns, outside
// node_modules entirely (measured directly: a real workspace-symlink
// resolution's own `resolvedFileName` already comes back as the real,
// symlink-followed path, e.g. `<root>/packages/b/src/index.ts`, not
// `<root>/node_modules/<pkg>/src/index.ts`). A genuine external dependency
// resolves to a real file that, however it's laid out (a plain copy, or a
// pnpm content-addressed store under its own `node_modules/.pnpm/...`),
// never escapes SOME `node_modules` directory - `isExternalLibraryImport`
// itself guarantees the file came from one. So: still under a node_modules
// segment after resolution -> genuinely external; escaped every
// node_modules segment and lands inside this project's own root -> a
// workspace sibling, not an external target.
function isWorkspaceSiblingResolution(resolvedFile: string, rootDir: string): boolean {
  if (resolvedFile.split(sep).includes("node_modules")) return false;
  const rel = relative(rootDir, resolvedFile);
  return !(rel.startsWith("..") || rel === resolvedFile);
}

// A hand-authored `.d.ts` is excluded from analysis by default - most are
// either a third-party ambient declaration with no real source in this
// project, or a generated twin of a real `.ts` file, neither one "module
// content" this tool should walk as its own file. But a project whose
// real, intentional public-surface convention IS a hand-authored `.d.ts`
// (a webpack-built package publishing `"types": "./types.d.ts"` with no
// `index.ts` at all, a real, measured case) can never be modeled at all
// otherwise - a `.d.ts` a declaredModules entry's own `surface` glob
// explicitly names is the one, narrow exception: an explicit config
// choice, not a blanket re-inclusion of every declaration file.
// `dm`'s own effective surface (hand-set, derived from a real package.json
// exports map, or the project's own global default - effectiveSurface's
// own precedence) relative to its module's own base directory
// (moduleGlobBaseDir of `dm.glob`), one project-relative glob per surface
// entry - a single string normalizes to one entry, an array to one per
// element.
export function surfaceGlobsFor(
  dm: DeclaredModule,
  projectRoot: string,
  globalDefaultSurface: string | readonly string[],
): string[] {
  const moduleDir = join(projectRoot, moduleGlobBaseDir(dm.glob));
  const surface = effectiveSurface(dm, moduleDir, globalDefaultSurface);
  const entries = Array.isArray(surface) ? surface : [surface as string];
  return entries.map((s) => moduleRelativeGlob(projectRoot, dm.glob, s));
}

function surfaceGlobsAllowingDts(
  declaredModules: readonly DeclaredModule[],
  projectRoot: string,
  globalDefaultSurface: string | readonly string[],
): string[] {
  return declaredModules
    .flatMap((dm) => surfaceGlobsFor(dm, projectRoot, globalDefaultSurface))
    .filter((g) => isDeclarationFile(g));
}

// A build-output path's own extension, swapped for the real source
// extension(s) every one of these ships from - never guessed beyond this
// fixed, small set (a project using some other build layout entirely
// simply isn't derivable, and falls back to the tool's own default
// instead of a wrong guess). More than one candidate per built extension
// (e.g. ".js" -> both ".ts" and ".tsx") - a React package's own built
// "./dist/index.js" ships from "index.tsx", not "index.ts", and the first
// existing guess wins (existsSync in the caller's own loop).
const BUILT_TO_SOURCE_EXTENSIONS: readonly [string, readonly string[]][] = [
  [".d.mts", [".mts", ".ts"]],
  [".d.cts", [".cts", ".ts"]],
  [".d.ts", [".ts", ".tsx"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
  [".js", [".ts", ".tsx"]],
];

// One export subpath's own value (a bare string, or a conditions object)
// resolved to the one real, existing source file it names - or undefined
// when nothing in it can be confidently resolved. A source-pointing
// condition (a project-specific key ending in "-source", the real
// convention this was measured against) is preferred when present, since
// it already names the real source path directly, with no built-output
// heuristic needed at all. Otherwise, tries "types"/"import"/"require"/
// "default" in that order, applying the fixed built-to-source extension
// swap and a single "dist/" prefix strip, then confirms the guess is a
// real file - a project whose own build output lives somewhere other
// than a literal "dist/" directory, or under some other convention
// entirely, is simply not derivable this way, not guessed wrong.
function resolveExportsEntry(value: unknown, moduleDir: string): string | undefined {
  const candidates: string[] = [];
  if (typeof value === "string") {
    candidates.push(value);
  } else if (typeof value === "object" && value !== null) {
    const conditions = value as Record<string, unknown>;
    const sourceKey = Object.keys(conditions).find((k) => k.endsWith("-source"));
    for (const key of [sourceKey, "types", "import", "require", "default"]) {
      if (key === undefined) continue;
      const v = conditions[key];
      if (typeof v === "string") candidates.push(v);
    }
  }

  for (const raw of candidates) {
    const stripped = raw.replace(/^\.\//, "");
    // A declaration output must still pass through the built-to-source
    // conversion below; a bare .ts/.tsx/.mts/.cts is already real source.
    const isDeclaration = isDeclarationFile(stripped);
    const asSource =
      !isDeclaration && ANALYZED_EXTENSIONS.some((ext) => stripped.endsWith(ext)) ? stripped : undefined;
    const guesses =
      asSource !== undefined
        ? [asSource]
        : BUILT_TO_SOURCE_EXTENSIONS.filter(([ext]) => stripped.endsWith(ext)).flatMap(([ext, replacements]) =>
            replacements.map((replacement) => stripped.replace(/^dist\//, "").slice(0, -ext.length) + replacement),
          );
    for (const guess of guesses) {
      if (existsSync(join(moduleDir, guess))) return guess;
    }
  }
  return undefined;
}

// Every real, sanctioned entry point a package.json's own `exports` map
// names, resolved back to its own real source file - or undefined when
// the map is absent, empty of real subpaths, or even one entry can't be
// confidently resolved (whole-module fallback to the tool's own default,
// never a partial or guessed-wrong surface array).
// Deliberately NOT cached across calls: buildModuleGraphForRules rebuilds
// the whole graph on a package.json exports edit, and a cache keyed only
// by moduleDir would return the stale, pre-edit surface for that same
// rebuild (measured directly - a test writing a new exports map to the
// same package.json between two builds got the first build's answer
// back). buildDeclaredModules and listAnalyzedFiles each reach this a few
// times per module per scan (surfaceName, surfaceGlobsFor's own dts
// check), not once per candidate file, so leaving it uncached costs a few
// reads per module per build, independent of file count.
function deriveSurfaceFromExports(moduleDir: string): string[] | undefined {
  const pkgPath = join(moduleDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof pkg !== "object" || pkg === null) return undefined;
  const exportsField: unknown = (pkg as Record<string, unknown>).exports;
  if (exportsField === undefined) return undefined;

  // A single string, or a bare conditions object (keys like "types"/
  // "import" that don't start with "."), names only the package's own
  // default "." entry - not a subpath map at all.
  const isSubpathMap =
    typeof exportsField === "object" &&
    exportsField !== null &&
    Object.keys(exportsField).every((k) => k.startsWith("."));
  const subpaths: Record<string, unknown> = isSubpathMap
    ? (exportsField as Record<string, unknown>)
    : { ".": exportsField };

  const resolved: string[] = [];
  for (const [key, value] of Object.entries(subpaths)) {
    if (key === "./package.json") continue; // a real file, but never TypeScript source
    if (value === null) continue; // explicitly blocked by the package's own author - not a leak candidate
    const source = resolveExportsEntry(value, moduleDir);
    if (source === undefined) return undefined; // one unresolvable entry fails the whole derivation
    if (!resolved.includes(source)) resolved.push(source);
  }
  return resolved.length > 0 ? resolved : undefined;
}

// A declared module's own effective surface: its own hand-set surface if
// present (wins unconditionally), else a real package.json's own exports
// map derived back to source (every real, sanctioned entry point at
// once), else the project's own global default - never a mix of derived
// and hand-set for the same module.
function effectiveSurface(
  dm: DeclaredModule,
  moduleDir: string,
  globalDefaultSurface: string | readonly string[],
): string | readonly string[] {
  if (dm.surface !== undefined) return dm.surface;
  return deriveSurfaceFromExports(moduleDir) ?? globalDefaultSurface;
}

// A named import/export clause is type-only either as a whole
// (`import type { X } from "..."`) or per specifier
// (`import { type X } from "..."`, the modifier on one named binding
// rather than the whole declaration) - TypeScript allows both forms, and
// only the first was ever checked here (measured directly: a minimal
// two-module fixture whose only edge is `import { type X } from "../b"`
// reported `isTypeOnly: false`, producing a false-positive cycle with a
// real value edge the other way). A default import binding
// (`import Foo, { type X } from "..."`) can never be per-specifier
// type-only itself, so its presence always makes the whole import a real
// value reference regardless of any named specifier's own modifier; same
// for a namespace import (`import * as X`), which has no per-specifier
// form at all. So: type-only only when the whole declaration says so, OR
// every named specifier does and neither a default nor a namespace
// binding exists on the same declaration.
function isEffectivelyTypeOnlyImport(importClause: ts.ImportClause | undefined): boolean {
  if (importClause === undefined) return false; // a side-effect-only `import "./x"` is a real reference
  if (importClause.isTypeOnly) return true;
  if (importClause.name !== undefined) return false;
  const bindings = importClause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

// The export-side twin of isEffectivelyTypeOnlyImport - `export { type X }
// from "..."` has the identical per-specifier-vs-whole-declaration
// distinction `export type { X } from "..."` already gets right.
function isEffectivelyTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

// Exported (not just used internally by prepareGraph) so init's own fresh-
// run walk sees exactly the file set check will analyze - a second,
// hand-rolled scan here would drift from isEligibleSourceFile's own rules
// (node_modules/dist segments, .d.ts, exclude globs) the moment either one
// changed without the other.
export function listAnalyzedFiles(
  projectRoot: string,
  excludeGlobs: readonly string[],
  declaredModules: readonly DeclaredModule[] = [],
  globalDefaultSurface: string | readonly string[] = DEFAULT_SURFACE,
): string[] {
  // Computed once for the whole scan, not once per .d.ts candidate file:
  // surfaceGlobsAllowingDts itself derives every module's own surface from
  // its package.json (a file read plus a JSON.parse per module), and a
  // project can have thousands of .d.ts candidates in one readDirectory
  // call - isEligibleSourceFile's own exported form still recomputes this
  // per call (safe there: callers of that form check a handful of files,
  // not the whole tree).
  const dtsSurfaceGlobs = surfaceGlobsAllowingDts(declaredModules, projectRoot, globalDefaultSurface);
  return ts.sys
    .readDirectory(projectRoot, ANALYZED_EXTENSIONS, ["**/node_modules/**", "**/dist/**"])
    .filter((file) => isEligibleSourceFileWithDtsGlobs(file, projectRoot, excludeGlobs, dtsSurfaceGlobs));
}

function countNonTsSourceFiles(rootDir: string, excludeGlobs: readonly string[]): number {
  return ts.sys
    .readDirectory(rootDir, [".js", ".mjs", ".cjs"], ["**/node_modules/**", "**/dist/**"])
    .filter((file) => !excludeGlobs.some((glob) => compileGlob(glob).test(toProjectRelativePosix(file, rootDir))))
    .length;
}

// A proposed new path has never passed through ts.sys.readDirectory.
// Export the eligibility predicate so callers can ask whether that path
// would qualify, using the same rules as the real scan. Keeping these
// rules separate from directory traversal lets both paths agree before
// the proposed file exists on disk.
export function isEligibleSourceFile(
  file: string,
  projectRoot: string,
  excludeGlobs: readonly string[],
  declaredModules: readonly DeclaredModule[],
  globalDefaultSurface: string | readonly string[],
): boolean {
  return isEligibleSourceFileWithDtsGlobs(
    file,
    projectRoot,
    excludeGlobs,
    surfaceGlobsAllowingDts(declaredModules, projectRoot, globalDefaultSurface),
  );
}

// Shared core: takes the already-derived .d.ts-allowing surface globs
// rather than declaredModules directly, so a caller scanning many files at
// once (listAnalyzedFiles) can derive them exactly once for the whole
// scan instead of once per candidate file.
function isEligibleSourceFileWithDtsGlobs(
  file: string,
  projectRoot: string,
  excludeGlobs: readonly string[],
  dtsSurfaceGlobs: readonly string[],
): boolean {
  const rel = toProjectRelativePosix(file, projectRoot);
  if (
    !ANALYZED_EXTENSIONS.some((ext) => file.endsWith(ext)) ||
    rel.split("/").some((part) => part === "node_modules" || part === "dist")
  ) {
    return false;
  }
  if (excludeGlobs.some((glob) => compileGlob(glob).test(rel))) return false;
  return !isDeclarationFile(file) || dtsSurfaceGlobs.some((glob) => compileGlob(glob).test(rel));
}

function buildDeclaredModules(
  projectRoot: string,
  declaredModules: readonly DeclaredModule[],
  allFiles: readonly string[],
  globalDefaultSurface: string | readonly string[] = DEFAULT_SURFACE,
): Map<string, Module> {
  const membership = declaredModules.map((dm) => ({ glob: dm.glob, value: dm.name }));
  const modules = new Map<string, Module>(
    declaredModules.map((dm): [string, Module] => {
      const dir = join(projectRoot, moduleGlobBaseDir(dm.glob));
      return [
        dm.name,
        {
          name: dm.name,
          dir,
          rootIsFile: pathIsFile(dir),
          files: [],
          surfaceFiles: [],
          surfaceName: effectiveSurface(dm, dir, globalDefaultSurface),
          friends: (dm.friends ?? []).map((f) => ({
            fileGlob: moduleRelativeGlob(projectRoot, dm.glob, f.file),
            from: f.from,
            because: f.because,
          })),
        },
      ];
    }),
  );

  const surfaceGlobs = new Map(
    declaredModules.map((dm) => [dm.name, surfaceGlobsFor(dm, projectRoot, globalDefaultSurface).map((g) => compileGlob(g))]),
  );

  for (const file of allFiles) {
    const rel = toProjectRelativePosix(file, projectRoot);
    const name = mostSpecificMatch(rel, membership, (a, b) => a === b);
    if (name === undefined) continue;
    // Only surfaceFiles is populated here - `files` (every file, not just
    // the surface) is populated once, in buildModuleGraph's shared walk
    // loop - not duplicated here.
    // surfaceFiles is the UNION of every configured surface glob's own
    // matches - a real package can publish more than one real, equally
    // public entry point at once.
    const globs = surfaceGlobs.get(name)!;
    if (globs.some((g) => g.test(rel))) {
      modules.get(name)!.surfaceFiles.push(file);
    }
  }
  for (const module of modules.values()) {
    module.surfaceFiles.sort();
  }
  return modules;
}

export function moduleForDeclaredFile(
  filePath: string,
  projectRoot: string,
  declaredModules: readonly DeclaredModule[],
): string | undefined {
  const rel = toProjectRelativePosix(filePath, projectRoot);
  return mostSpecificMatch(
    rel,
    declaredModules.map((dm) => ({ glob: dm.glob, value: dm.name })),
    (a, b) => a === b,
  );
}

function readCompilerOptions(configPath: string): ts.CompilerOptions {
  const { config } = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  // basePath = the config's own directory - a leaf tsconfig's own `paths`
  // (a per-package alias, e.g. "@/*": ["./src/*"]) resolves relative to
  // THIS, not the project root; parseJsonConfigFileContent computes
  // `pathsBasePath` from it. Hand-merging option objects instead of
  // reusing this real TypeScript call would resolve `paths` against the
  // wrong root and produce a different wrong answer, not a correct one.
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath)).options;
}

function loadCompilerOptions(startDir: string): { configPath: string | undefined; options: ts.CompilerOptions } {
  const configPath = ts.findConfigFile(startDir, ts.sys.fileExists.bind(ts.sys));
  if (configPath === undefined) {
    return { configPath: undefined, options: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext } };
  }
  return { configPath, options: readCompilerOptions(configPath) };
}

// Module resolution needs each file's OWN nearest tsconfig.json, not just
// the one at the project root - a real TypeScript monorepo convention
// (findConfigFile walking up from the importing file's own directory),
// and the one this project's own resolver measurably missed: a leaf
// package's own `paths` alias (or a jsx/moduleResolution override) was
// invisible when every file resolved under the same, single root config,
// inflating unresolvedSpecifierCount for every aliased import in that
// package. Cached by the config file's own path (a monorepo has one
// config per package, not one per file) - a directory with no nearer
// config than the project root's own reuses the already-parsed root
// options rather than re-parsing the same file per directory.
//
// Scope of this fix, stated plainly: this only changes what
// `ts.resolveModuleName` is called with for edge resolution - it does
// NOT change the shared `ts.Program`/`TypeChecker` every module in the
// graph is checked against (rule 6, `graph.checker`, still uses the
// project-root's own compiler options for the whole program, the same as
// before). `ts.createProgram` itself also resolves each root file's own
// imports internally, under the root options, to decide what enters the
// program at all - a leaf package's own aliased import can still fail
// there even once this makes its own edge resolve correctly for
// unresolvedSpecifierCount's sake. Mixing genuinely incompatible
// per-file options (target, jsx) into one shared program is a real,
// separate architectural question this fix does not attempt.
function makeCompilerOptionsForFile(
  rootOptions: ts.CompilerOptions,
  rootConfigPath: string | undefined,
): (filePath: string) => ts.CompilerOptions {
  const optionsByConfigPath = new Map<string, ts.CompilerOptions>();
  if (rootConfigPath !== undefined) optionsByConfigPath.set(rootConfigPath, rootOptions);
  // The cache above already stops readCompilerOptions from re-parsing the
  // same tsconfig.json twice, but ts.findConfigFile itself still does one
  // fileExists check per directory level between a file and its nearest
  // config - that walk ran again for every file in the same directory,
  // and buildPreparedGraph's edge walk calls this once per import
  // specifier (not once per file), so a file with several imports
  // repeated its own directory's walk several times over.
  // graphBuildFingerprint also calls this once per root file, through the
  // same closure, when buildModuleGraphForRules checks its cache before
  // buildPreparedGraph's own edge walk runs - repeating every directory's
  // walk a second time. Caching by the starting directory turns each
  // directory's own walk into one lookup after its first caller.
  const configPathByDir = new Map<string, string | undefined>();
  return (filePath: string): ts.CompilerOptions => {
    const dir = dirname(filePath);
    let configPath = configPathByDir.get(dir);
    if (configPath === undefined && !configPathByDir.has(dir)) {
      configPath = ts.findConfigFile(dir, ts.sys.fileExists.bind(ts.sys));
      configPathByDir.set(dir, configPath);
    }
    if (configPath === undefined) return rootOptions;
    const cached = optionsByConfigPath.get(configPath);
    if (cached !== undefined) return cached;
    const options = readCompilerOptions(configPath);
    optionsByConfigPath.set(configPath, options);
    return options;
  };
}

export function prepareGraph(options: BuildOptions) {
  // Realpath'd up front, not just at whichever comparison happens to need
  // it: TypeScript's own resolver already returns a symlink-resolved
  // `resolvedFileName` for any import that passes through one (measured
  // directly - a workspace package symlinked into node_modules, and
  // separately, a platform's own tmp-directory symlink like macOS's
  // /tmp -> /private/tmp), so a non-realpath'd `projectRoot` would make
  // every relative-path computation downstream (toProjectRelativePosix,
  // declaredModules glob matching, exclude glob matching) silently
  // disagree with the paths TypeScript itself already resolved to.
  const { declaredModules, surface = DEFAULT_SURFACE, exclude = [] } = options;
  const projectRoot = realpathSync(options.projectRoot);
  const { configPath: rootConfigPath, options: compilerOptions } = loadCompilerOptions(projectRoot);
  const compilerOptionsForFile = makeCompilerOptionsForFile(compilerOptions, rootConfigPath);

  const rootDir = projectRoot;
  let rootNames = listAnalyzedFiles(projectRoot, exclude, declaredModules, surface);
  if (options.fileListOverride) rootNames = options.fileListOverride(rootNames);
  const modules = buildDeclaredModules(projectRoot, declaredModules, rootNames, surface);
  // Cached by absolute file path: buildPreparedGraph calls this once per
  // source file AND once per edge's resolvedFile, and a widely-imported
  // file (a shared utils module, a design-system entry point) is a common
  // edge target hundreds of times over in a real codebase - each repeat
  // was a fresh O(declaredModules) glob-match walk over the exact same
  // answer. Safe for the lifetime of one prepareGraph call: projectRoot
  // and declaredModules are both fixed for that call.
  const moduleForFileCache = new Map<string, string | undefined>();
  const resolveModuleForFile = (filePath: string) => {
    if (moduleForFileCache.has(filePath)) return moduleForFileCache.get(filePath);
    const result = moduleForDeclaredFile(filePath, projectRoot, declaredModules);
    moduleForFileCache.set(filePath, result);
    return result;
  };

  const nonTsSourceFileCount = countNonTsSourceFiles(rootDir, exclude);
  return { projectRoot, surface, rootDir, rootNames, modules, resolveModuleForFile, compilerOptions, compilerOptionsForFile, nonTsSourceFileCount };
}

export function buildModuleGraph(options: BuildOptions): ModuleGraph {
  return buildPreparedGraph(prepareGraph(options));
}

// One import/export/dynamic-import specifier found while walking a single
// file, before resolution - resolution needs the file's own nearest
// compiler options and a live host, neither of which this record carries,
// so it is a pure, resolution-independent fact about the file's own
// syntax. warm-graph.ts caches exactly this shape (keyed by file path and
// mtime) to skip re-parsing an unchanged file while still resolving every
// specifier afresh on each refresh.
export type ImportRecord = {
  specifier: string;
  fromPosition: Position;
  isTypeOnly: boolean;
  isDynamic: boolean;
};

export type FileImportWalk = {
  imports: ImportRecord[];
  unsupportedSyntaxCount: number;
};

// TypeScript's own default (ensureScriptKind, applied when a caller of
// ts.createSourceFile omits scriptKind) already maps every analyzed
// extension this way - .tsx to TSX, everything else (.ts/.mts/.cts) to
// plain TS, since ts.ScriptKind itself has no separate Mts/Cts member.
// Made explicit here rather than left to that implicit default: this
// project's per-file parse is deliberate about which of TypeScript's own
// two source dialects (JSX-capable or not) it invokes, not a place that
// should silently follow whatever TypeScript's own default happens to be
// this version. Exported: warm-graph.ts's own per-file cache parses a
// file the same way, outside this module's own buildPreparedGraph.
export function scriptKindForFile(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

// The per-file half of the edge walk: every import/export/dynamic-import
// specifier syntax recognizes, plus a count of syntax it doesn't
// (require(), import x = require(...)) - no resolution, no Program, no
// module graph. Kept separate from buildPreparedGraph's own resolution
// loop below so warm-graph.ts can memoize exactly this part.
export function walkFileImports(sf: ts.SourceFile): FileImportWalk {
  const imports: ImportRecord[] = [];
  let unsupportedSyntaxCount = 0;

  ts.forEachChild(sf, function walk(node) {
    let specifier: ts.Expression | undefined;
    let isTypeOnly = false;
    let isDynamic = false;

    if (ts.isImportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      isTypeOnly = isEffectivelyTypeOnlyImport(node.importClause);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      specifier = node.moduleSpecifier;
      isTypeOnly = isEffectivelyTypeOnlyExport(node);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0];
      isDynamic = true;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      // `import x = require("./y")`: a CommonJS-only form, outside the
      // ESM scope this project analyzes.
      unsupportedSyntaxCount++;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      unsupportedSyntaxCount++;
    }

    if (specifier !== undefined && ts.isStringLiteral(specifier)) {
      const start = specifier.getStart(sf);
      const { line, character } = sf.getLineAndCharacterOfPosition(start);
      imports.push({
        specifier: specifier.text,
        fromPosition: { line: line + 1, column: character + 1 },
        isTypeOnly,
        isDynamic,
      });
    }

    ts.forEachChild(node, walk);
  });

  return { imports, unsupportedSyntaxCount };
}

export type GraphBuildOverrides = {
  host?: ts.CompilerHost;
  oldProgram?: ts.Program;
  resolutionCache?: ts.ModuleResolutionCache;
  // warm-graph.ts's own per-file, mtime-keyed cache of walkFileImports'
  // result - supplied so a refresh can skip re-parsing an unchanged file.
  // Returning undefined means "this file has no readable content" (the
  // same case the default, host.readFile-based walk below treats as: the
  // file is skipped entirely, exactly as a Program that failed to read a
  // root file simply omits it from getSourceFiles()).
  fileWalk?: (fileName: string) => FileImportWalk | undefined;
};

export function buildPreparedGraph(prepared: ReturnType<typeof prepareGraph>, overrides: GraphBuildOverrides = {}): ModuleGraph {
  const { projectRoot, surface, rootDir, rootNames, modules, resolveModuleForFile, compilerOptions, compilerOptionsForFile } = prepared;
  const host = overrides.host ?? ts.createCompilerHost(compilerOptions);
  const languageVersion = compilerOptions.target ?? ts.ScriptTarget.ESNext;

  const defaultFileWalk = (fileName: string): FileImportWalk | undefined => {
    const text = host.readFile(fileName);
    if (text === undefined) return undefined;
    return walkFileImports(ts.createSourceFile(fileName, text, languageVersion, false, scriptKindForFile(fileName)));
  };
  const fileWalk = overrides.fileWalk ?? defaultFileWalk;

  // One ts.ModuleResolutionCache per distinct compiler-options object
  // (a monorepo can have many, one per leaf tsconfig - see
  // compilerOptionsForFile's own comment), unless the caller supplies one
  // cache to use for every file regardless of its own options
  // (overrides.resolutionCache - simulate.ts's own single-cache-per-run
  // convention, kept as-is here).
  const resolutionCaches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const resolutionCacheFor = (options: ts.CompilerOptions): ts.ModuleResolutionCache | undefined => {
    if (overrides.resolutionCache !== undefined) return overrides.resolutionCache;
    let cache = resolutionCaches.get(options);
    if (cache === undefined) {
      cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, options);
      resolutionCaches.set(options, cache);
    }
    return cache;
  };

  const outsideFiles: string[] = [];
  const edges: Edge[] = [];
  let unsupportedSyntaxCount = 0;
  let unresolvedSpecifierCount = 0;
  const unresolvedSpecifiers: string[] = [];

  // Walked in rootNames order (listAnalyzedFiles' own directory-scan
  // order), not program.getSourceFiles()'s dependency order - there is no
  // Program to walk here. Every edges/modules-membership/outsideFiles
  // consumer that cares about a stable order sorts at its own site rather
  // than leaning on this order (see each rule's own comment where that
  // applies); this loop makes no ordering promise beyond "rootNames order".
  for (const fileName of rootNames) {
    const walked = fileWalk(fileName);
    if (walked === undefined) continue; // unreadable: invisible, matching a Program that never got a SourceFile for it either

    const fromModule = resolveModuleForFile(fileName);
    if (fromModule === undefined) {
      outsideFiles.push(fileName);
      continue;
    }
    modules.get(fromModule)?.files.push(fileName);
    unsupportedSyntaxCount += walked.unsupportedSyntaxCount;

    const options = compilerOptionsForFile(fileName);
    const cache = resolutionCacheFor(options);

    for (const imp of walked.imports) {
      const builtin = builtinModuleName(imp.specifier);

      if (builtin !== undefined) {
        // No real resolvedFile exists for a builtin - the specifier
        // itself (normalized to the bare, "node:"-stripped name) stands
        // in for one, matching every other external edge's convention of
        // a stable, human-readable identifier rather than a filesystem
        // path that doesn't exist.
        edges.push({
          fromFile: fileName,
          fromModule,
          fromPosition: imp.fromPosition,
          specifier: imp.specifier,
          isTypeOnly: imp.isTypeOnly,
          isDynamic: imp.isDynamic,
          resolvedFile: `node:${builtin}`,
          toModule: undefined,
          externalPackage: builtin,
        });
        continue;
      }

      // Resolved regardless of a leading "." - a bare specifier
      // (`@internal/a`, `lodash`) is resolved the same way a relative
      // one is; TS's own resolver already follows a workspace
      // package's package.json `exports` under nodenext, so the only
      // thing gating that path before was this project's own code,
      // not TypeScript.
      const resolved = ts.resolveModuleName(imp.specifier, fileName, options, host, cache);
      const resolvedModule = resolved.resolvedModule;
      if (resolvedModule === undefined) {
        unresolvedSpecifierCount++;
        unresolvedSpecifiers.push(imp.specifier);
        continue;
      }
      const resolvedFile = resolvedModule.resolvedFileName;
      const toModule = resolveModuleForFile(resolvedFile);
      const externalPackage =
        resolvedModule.isExternalLibraryImport && !isWorkspaceSiblingResolution(resolvedFile, projectRoot)
          ? (resolvedModule.packageId?.name ?? imp.specifier.replace(/^node:/, ""))
          : undefined;
      edges.push({
        fromFile: fileName,
        fromModule,
        fromPosition: imp.fromPosition,
        specifier: imp.specifier,
        isTypeOnly: imp.isTypeOnly,
        isDynamic: imp.isDynamic,
        resolvedFile,
        toModule,
        externalPackage,
      });
    }
  }

  const crossModuleEdges = edges.filter(
    (e) => e.toModule !== undefined && e.toModule !== e.fromModule,
  );

  // Built only on first access to `program`/`checker`, and dropped again
  // by `releaseProgram` - see this module's own header and the
  // `ModuleGraph.program`/`releaseProgram` field comments for why.
  let program: ts.Program | undefined;
  const ensureProgram = (): ts.Program => {
    program ??= ts.createProgram({ rootNames, options: compilerOptions, host: overrides.host, oldProgram: overrides.oldProgram });
    return program;
  };

  return {
    modules,
    edges,
    crossModuleEdges,
    outsideFiles,
    nonTsSourceFileCount: prepared.nonTsSourceFileCount,
    unsupportedSyntaxCount,
    unresolvedSpecifierCount,
    unresolvedSpecifiers,
    surface,
    rootDir,
    get program() {
      return ensureProgram();
    },
    get checker() {
      return ensureProgram().getTypeChecker();
    },
    releaseProgram() {
      program = undefined;
    },
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const ARCHSTRICT_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function cacheMetadata(projectRoot: string, options: BuildOptions): Record<string, number | null> {
  const packages = [join(projectRoot, "package.json"), ...options.declaredModules
    .map((dm) => join(projectRoot, moduleGlobBaseDir(dm.glob), "package.json"))];
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]
    .map((name) => join(projectRoot, name)).find((path) => existsSync(path));
  if (lock !== undefined) packages.push(lock);
  return Object.fromEntries([...new Set(packages)].sort().map((path) => [path, existsSync(path) ? statSync(path).mtimeMs : null]));
}

export function graphBuildFingerprint(options: BuildOptions, prepared: ReturnType<typeof prepareGraph>) {
  const { projectRoot, rootNames, compilerOptions, compilerOptionsForFile } = prepared;
  const tsconfigHash = hash({ root: compilerOptions, files: rootNames.map((file) => [file, compilerOptionsForFile(file)]) });
  const buildOptionsHash = hash({ declaredModules: options.declaredModules,
    exclude: options.exclude, surface: prepared.surface });
  const metadata = cacheMetadata(projectRoot, options);
  return { tsconfigHash, buildOptionsHash, metadata, archstrictVersion: ARCHSTRICT_VERSION };
}

// File membership, nearest compiler options, and package metadata all affect
// resolution. A change to any input discards the entire snapshot.
export function buildModuleGraphForRules(options: BuildOptions): ModuleGraph {
  const prepared = prepareGraph(options);
  const { projectRoot, rootNames, modules, resolveModuleForFile } = prepared;
  const path = join(projectRoot, "node_modules/.cache/archstrict/edges.json");
  const { tsconfigHash, buildOptionsHash, metadata } = graphBuildFingerprint(options, prepared);
  const mtimes = Object.fromEntries(rootNames.map((file) => [file, statSync(file).mtimeMs]));
  const cached = readEdgeCache(path);
  if (cached !== undefined && cached.archstrictVersion === ARCHSTRICT_VERSION && cached.tsconfigHash === tsconfigHash &&
      cached.buildOptionsHash === buildOptionsHash && hash(cached.metadata) === hash(metadata) &&
      Object.keys(cached.files).length === rootNames.length &&
      rootNames.every((file) => cached.files[file]?.mtimeMs === mtimes[file])) {
    const edges: Edge[] = [];
    const outsideFiles: string[] = [];
    for (const file of cached.sourceOrder) {
      // A file the walk could not read is invisible on a cold build too
      // (module-graph.ts's own per-file walk: an unreadable file joins
      // neither a module's own `files` nor `outsideFiles`) - its cache
      // entry carries no edges either way, but membership must still
      // skip it to replay that same invisibility, not just its edges.
      if (cached.files[file]!.unreadable) continue;
      const owner = resolveModuleForFile(file);
      if (owner === undefined) outsideFiles.push(file);
      else modules.get(owner)?.files.push(file);
      for (const edge of cached.files[file]!.edges) {
        // JSON omits undefined fields; restore the same Edge shape as a fresh walk.
        edges.push({ ...edge, fromModule: owner!, toModule: edge.resolvedFile.startsWith("node:") ? undefined : resolveModuleForFile(edge.resolvedFile),
          externalPackage: edge.externalPackage });
      }
    }
    let fullGraph: ModuleGraph | undefined;
    // Building the full graph just to reach its Program re-walks every
    // file for edges this branch already has cached - wasteful, but
    // `program`/`checker` are each still lazy getters on the result, so
    // that cost is paid only if a caller actually touches one of them.
    const full = () => fullGraph ??= buildModuleGraph(options);
    return { modules, edges, outsideFiles,
      nonTsSourceFileCount: prepared.nonTsSourceFileCount,
      crossModuleEdges: edges.filter((e) => e.toModule !== undefined && e.toModule !== e.fromModule),
      unsupportedSyntaxCount: cached.unsupportedSyntaxCount,
      unresolvedSpecifierCount: cached.unresolvedSpecifiers.length,
      unresolvedSpecifiers: cached.unresolvedSpecifiers,
      surface: prepared.surface, rootDir: prepared.rootDir,
      get program() { return full().program; },
      get checker() { return full().checker; },
      releaseProgram() { fullGraph?.releaseProgram(); fullGraph = undefined; },
    };
  }
  const graph = buildPreparedGraph(prepared);
  // Every rootName the walk actually read - the union of every module's
  // own `files` and `outsideFiles` - never includes a file the host
  // could not read (buildPreparedGraph's own per-file walk treats that
  // file as invisible, joining neither list). A rootName missing from
  // this set gets `unreadable: true` below, so a cache hit can replay
  // that same invisibility instead of treating a stale cache format's
  // silent inclusion as membership.
  const readFiles = new Set([...[...graph.modules.values()].flatMap((m) => m.files), ...graph.outsideFiles]);
  const files: EdgeCache["files"] = Object.fromEntries(rootNames.map((file) =>
    [file, { mtimeMs: mtimes[file]!, edges: [], ...(readFiles.has(file) ? {} : { unreadable: true as const }) }]));
  for (const edge of graph.edges) files[edge.fromFile]!.edges.push(edge);
  // Do not label an analysis with mtimes from a concurrent edit.
  if (rootNames.every((file) => existsSync(file) && statSync(file).mtimeMs === mtimes[file])) {
    // rootNames order (a directory scan) - this write never builds a
    // Program at all (see buildPreparedGraph's own header for why).
    writeEdgeCache(path, { schema: 2, tsconfigHash, archstrictVersion: ARCHSTRICT_VERSION, buildOptionsHash, metadata, files,
      sourceOrder: rootNames.filter((file) => Object.hasOwn(files, file)),
      unsupportedSyntaxCount: graph.unsupportedSyntaxCount, unresolvedSpecifiers: graph.unresolvedSpecifiers });
  }
  return graph;
}
