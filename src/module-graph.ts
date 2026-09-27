// Responsibility: build every declared module's own file membership and
// resolve every import/export/dynamic-import/import-type edge to its target module.
// This is shared infrastructure: every rule (public-surface bypass,
// cycles, uncovered modules, deprecated edges) and every verb reads the
// same graph rather than each re-walking the source.
// Boundary: no rule logic here. A rule is a predicate over this graph's
// edges and modules; this module only builds the graph and says what it
// could not analyze (unresolved specifiers, unsupported syntax, files
// outside the modules glob) as counts, never as silence.
// Two deliberate exceptions support rule 6. The Program builders call
// `checkTypeLeaks` because duplicate alias logic can omit required roots.
// The focused builder computes absent public names because loading every
// surface would remove the performance benefit of its smaller Program.
// Rule 6's closure Program resolves imports with each file's nearest tsconfig
// (`compilerOptionsForFile`, the same one the edge walk uses), not the
// project root's compiler options for every file alike, so a nested
// tsconfig's own `paths` resolves there the same way the edge walk
// resolves it.
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
import { readEdgeCache, writeEdgeCache, resolutionKey, type EdgeCache, type CachedFileEntry, type CachedResolution } from "./edge-cache.js";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { builtinModules } from "node:module";
import { compileGlob, mostSpecificMatch } from "./classify.js";
import { buildTypeClosure, computeSyntacticNamedDeclarations, type TypeClosureInputs } from "./type-closure.js";
import { checkTypeLeaks, type Violation as TypeLeakViolation } from "./rules/type-leak.js";

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
  // The program and checker built over the type-reachable closure from
  // every module's public surface (type-closure.ts), not every analyzed
  // file - shared here so a rule needing type information (rule 6) does
  // not build its own second program over the same files. Lazy: building
  // either one parses and binds every file in the program, the memory
  // cost this module's own edge build exists to avoid paying
  // unconditionally (see this module's own header) - so nothing on the
  // edge path may touch either getter, and a caller that never needs type
  // information never pays for a Program at all. A caller that needs
  // every analyzed file's own SourceFile present (simulate.ts's own
  // overlay check, for one) cannot use this getter for that - see
  // simulate.ts's own comment for why it checks `rootNames` and the
  // overlay host directly instead.
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  // Drops the memoized Program (and, with it, the checker) once a caller
  // that needed one (rule 6, search, fix) is done with it, so it does not
  // sit in memory for the rest of a run that has no further use for it. A
  // later access to `program`/`checker` builds a fresh one.
  releaseProgram(): void;
  // Empty unless building `program` needed the closure's own bounded
  // safety net to add a file the closure's ordinary rules missed, and
  // even then only once that net exhausted its own round limit and fell
  // back to the whole-project Program instead - see this module's own
  // `ensureProgram` for why. Populated only once `program`/`checker` has
  // actually been accessed; a caller that never touches either sees an
  // empty array here regardless.
  readonly programNotes: readonly string[];
  // A reused graph can serve an unscoped caller after a focused run.
  // Sharing `programNotes` is refused because scoped notes would leak across calls.
  readonly focusedTypeLeakNotes: readonly string[];
  // Rule 6's own findings against the exact Program `program` now holds -
  // set only when building that Program already ran rule 6's own walk to
  // do so (the closure's safety net), so `checkTypeLeaks(graph)` can reuse
  // it instead of walking the same Program a second time. Undefined
  // whenever that has not happened (no surface-owning module at all, or
  // the whole-project fallback, which does not run this walk itself).
  readonly cachedTypeLeaks?: TypeLeakViolation[];
  // An all-surface closure found 53 leaks to report 4 on a 23,000-file project.
  // `typeLeaksForFocus` rejects post-filtering and builds only focused roots.
  // A separate result prevents reused graphs from serving focused findings to unscoped callers.
  typeLeaksForFocus(moduleName: string): TypeLeakViolation[];
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

// A relative or bare specifier resolves through every one of these
// extensions, analyzed or not: a hand-authored .d.ts/.d.mts/.d.cts
// (declarations with no source counterpart), a plain .js/.mjs/.cjs/.jsx
// (an already-built or hand-written non-TypeScript sibling), a bare
// .json (an `import data.json` under `resolveJsonModule`), or one of the
// four ANALYZED_EXTENSIONS themselves under an exclude glob or outside
// every declared module's own glob - excluded from analysis, but not
// from what a specifier can resolve to. None of these is parsed or
// walked for its own imports here - only whether one exists at a given
// path can change which real file a specifier resolves to.
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts", ".js", ".mjs", ".cjs", ".jsx", ".json"] as const;

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
const NON_TS_SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

export type ProjectTreeWalk = {
  analyzedFiles: string[];
  nonTsSourceFileCount: number;
  resolvableFiles: string[];
  packageJsonFiles: string[];
  // Every node_modules directory the descent met, not descended into -
  // an ancestor of `projectRoot` itself is a separate, second source
  // (ancestorNodeModulesDirs), since it is never inside this walk's own
  // root at all.
  nodeModulesDirs: string[];
};

// One directory's own real identity, following any symlink - `undefined`
// for a broken symlink, or a directory this process cannot stat at all
// (invisible to this walk, the same as an unreadable file is).
function realDirOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

// Ordinal, case-sensitive comparison - plain `<`/`>` on the raw strings,
// never `localeCompare` (which is locale-sensitive and can reorder
// mixed-case or `_`-prefixed names differently across machines). Matches
// TypeScript's own `matchFiles`, whose real output this walk replaces
// (walk-parity tests compare directly against it) - a caller comparing
// this walk's own order against a fresh `ts.sys.readDirectory` call must
// see the identical order, not merely the identical file set.
function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A directory's own children, split into real files and real
// directories (a symlink resolved through statSync either way - a
// Dirent never resolves one on its own: isDirectory()/isFile() both
// read false for a symlink regardless of what it points at). A broken
// symlink, or an entry this process cannot stat at all, is invisible -
// the same as a file this walk can't read is everywhere else in this
// project. Each group comes back sorted with `ordinalCompare`, matching
// `matchFiles`' own order.
function readDirEntries(dir: string): { files: Dirent[]; dirs: { entry: Dirent; real: string }[] } {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: [] };
  }
  const files: Dirent[] = [];
  const dirs: { entry: Dirent; real: string }[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(full);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      const real = realDirOf(full);
      if (real !== undefined) dirs.push({ entry, real });
      continue;
    }
    if (isFile) files.push(entry);
  }
  files.sort((a, b) => ordinalCompare(a.name, b.name));
  dirs.sort((a, b) => ordinalCompare(a.entry.name, b.entry.name));
  return { files, dirs };
}

// One recursive descent of the project tree, in place of four separate
// directory walks: the analyzed file list, the non-TS source count, the
// resolvable-file set, and the outside-node_modules package.json list.
// node_modules is recorded but never descended into - the package names
// and package.json mtimes a resolution fingerprint needs from it come
// from listNodeModulesPackages instead, reading only that one directory's
// own top level. config.exclude applies to the analyzed list and the
// non-TS count only - never to the resolvable set or the package.json
// list, which describe what a specifier can reach, not what gets
// analyzed.
//
// dist/ is NEVER entered by this pass, unconditionally - not only under
// `analysisOnly` (see below). A real, measured case this fixes: a build
// tool symlinking a source directory straight into dist/ (`dist/shared
// -> ../src/shared`, a real pattern some bundlers use) reaches
// `src/shared`'s own real identity while walking dist/ alphabetically
// before src/ - if this pass's own visited set were shared with dist's
// own descent, `src/shared` would already be marked visited by the time
// this pass reaches it for real, and every file under it would silently
// vanish from the analyzed list. Every one of dist/'s own top-level
// directories this pass meets (never descended into) is instead handed
// to a second, wholly separate pass below - own visited set, never
// touching this pass's own analyzed output at all.
//
// `analysisOnly` (listAnalyzedFiles' own use, and every other caller that
// wants only the analyzed list) additionally skips collecting the
// resolvable set, the package.json list, and the node_modules directory
// list for the rest of the tree too (and skips the second, dist-only
// pass entirely) - each is real, avoidable work a caller that never
// reads those fields would otherwise pay for nothing.
// buildModuleGraphForRules' own resolutionInputs is the one caller that
// needs the fuller walk (`analysisOnly` false, prepareGraph's own
// default).
//
// Every directory's own real identity (following any symlink) is
// visited at most once per pass, first visit wins - the same rule
// TypeScript's own `matchFiles` follows. Without it, a symlink cycle (a
// directory symlinked back to one of its own ancestors) recurses forever
// in practice (bounded only by the filesystem's own path-length limit),
// and a directory reached twice through two different symlinks (or a
// symlink and its own real target) is listed twice over. Each pass's
// root (this walk's own `projectRoot` for the first; each dist/
// directory, independently, for the second) is seeded into that pass's
// own visited set before it starts, so a later symlink back to it (or to
// any directory already reached within that same pass) is caught the
// same way an ordinary cycle is.
//
// Measured directly on nukadoko-archstrict-adopt's own real tree (1,342
// files outside node_modules): the four separate ts.sys.readDirectory
// calls this replaces took about 41 ms; this one recursive descent takes
// about 23 ms - roughly 1.8x faster, from walking every directory once
// instead of four times.
function walkProjectTree(
  projectRoot: string,
  excludeGlobs: readonly string[],
  dtsSurfaceGlobs: readonly string[],
  analysisOnly = false,
): ProjectTreeWalk {
  const analyzedFiles: string[] = [];
  let nonTsSourceFileCount = 0;
  const resolvableFiles: string[] = [];
  const packageJsonFiles: string[] = [];
  const nodeModulesDirs: string[] = [];
  const distDirs: string[] = [];
  const visited = new Set<string>();

  function visit(dir: string): void {
    const { files, dirs } = readDirEntries(dir);

    for (const entry of files) {
      const full = join(dir, entry.name);
      if (entry.name === "package.json" && !analysisOnly) packageJsonFiles.push(full);
      if (!analysisOnly && RESOLVABLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) resolvableFiles.push(full);
      const rel = toProjectRelativePosix(full, projectRoot);
      if (excludeGlobs.some((glob) => compileGlob(glob).test(rel))) continue;
      if (NON_TS_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        nonTsSourceFileCount++;
      } else if (
        ANALYZED_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
        (!isDeclarationFile(full) || dtsSurfaceGlobs.some((glob) => compileGlob(glob).test(rel)))
      ) {
        analyzedFiles.push(full);
      }
    }

    for (const { entry, real } of dirs) {
      const full = join(dir, entry.name);
      if (entry.name === "node_modules") {
        if (!analysisOnly) nodeModulesDirs.push(full);
        continue;
      }
      // An exact, case-sensitive match on every platform: "Dist" or "DIST" stays analyzed even on
      // a case-insensitive file system, so one project gives the same analyzed list on macOS,
      // Windows and Linux.
      if (entry.name === "dist") {
        if (!analysisOnly) distDirs.push(full);
        continue; // never entered by this pass, unconditionally
      }
      if (visited.has(real)) continue;
      visited.add(real);
      visit(full);
    }
  }

  const rootReal = realDirOf(projectRoot);
  if (rootReal !== undefined) visited.add(rootReal);
  visit(projectRoot);

  // The second pass: every dist/ directory the first pass met, walked
  // separately for the resolvable set, the package.json list, and the
  // node_modules directory list only - never the analyzed list or the
  // non-TS count, and never sharing the first pass's own visited set.
  if (!analysisOnly) {
    const distVisited = new Set<string>();
    function visitDist(dir: string): void {
      const { files, dirs } = readDirEntries(dir);
      for (const entry of files) {
        const full = join(dir, entry.name);
        if (entry.name === "package.json") packageJsonFiles.push(full);
        if (RESOLVABLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) resolvableFiles.push(full);
      }
      for (const { entry, real } of dirs) {
        const full = join(dir, entry.name);
        if (entry.name === "node_modules") {
          nodeModulesDirs.push(full);
          continue;
        }
        if (distVisited.has(real)) continue;
        distVisited.add(real);
        visitDist(full);
      }
    }
    for (const dir of distDirs) {
      const real = realDirOf(dir);
      if (real === undefined || distVisited.has(real)) continue;
      distVisited.add(real);
      visitDist(dir);
    }
  }

  return { analyzedFiles, nonTsSourceFileCount, resolvableFiles, packageJsonFiles, nodeModulesDirs };
}

export function listAnalyzedFiles(
  projectRoot: string,
  excludeGlobs: readonly string[],
  declaredModules: readonly DeclaredModule[] = [],
  globalDefaultSurface: string | readonly string[] = DEFAULT_SURFACE,
): string[] {
  // Computed once for the whole scan, not once per .d.ts candidate file:
  // surfaceGlobsAllowingDts itself derives every module's own surface from
  // its package.json (a file read plus a JSON.parse per module), and a
  // project can have thousands of .d.ts candidates in one walk - the
  // exported, per-file isEligibleSourceFile still recomputes this per
  // call (safe there: callers of that form check a handful of files, not
  // the whole tree). `analysisOnly: true` - this function's only output
  // is the analyzed list, so dist/ is never entered and the other three
  // categories are never collected at all. `init` calls this 4-5 times,
  // each with its own exclude list (noise directories, colocated tests,
  // ...) - pruning each individual call, rather than sharing one fuller
  // walk across all of them, is the simpler of the two fixes for that:
  // `init` needs no change at all, and every other analysis-only caller
  // gets the same win for free. Measured directly on
  // nukadoko-archstrict-adopt (which has no dist/ of its own): `init`
  // took about 61 ms pruned and about 61 ms unpruned - indistinguishable
  // there, since this checkout has nothing under dist/ to skip; the
  // pruning still removes real work (a full descent into a real dist/
  // tree, plus the resolvable/package.json/node_modules collection) on
  // any project that has one.
  const dtsSurfaceGlobs = surfaceGlobsAllowingDts(declaredModules, projectRoot, globalDefaultSurface);
  return walkProjectTree(projectRoot, excludeGlobs, dtsSurfaceGlobs, true).analyzedFiles;
}

// A proposed new path has never passed through walkProjectTree.
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

// parseJsonConfigFileContent's real job (`include`/`exclude` -> a file
// list) is work this function throws away: it returns only `.options`.
// Given plain `ts.sys`, it still walks the whole subtree under `include`
// to build that discarded list - measured on a 23,000-file project at 234
// ms across the two calls loadCompilerOptions and makeCompilerOptionsForFile
// make per run (a root tsconfig.json's own `include` covering most of the
// tree, and a leaf one). `readDirectory: () => []` stops that walk: parsing
// still needs a real directory-read call, but "no entries" makes every
// glob match nothing, so the file list comes back empty rather than
// walking the tree to build one. `paths`/`baseUrl`/`extends` never expand
// `include`/`exclude` at all, so they resolve identically either way - a
// leaf tsconfig's own `paths` alias still resolves against ITS OWN
// directory (this function's own basePath, unaffected by the host).
// `fileExists`/`readFile` stay real: `extends` resolves another tsconfig
// file through them, and a stubbed one would silently fail to find it.
// An empty file list also makes parseJsonConfigFileContent add a "no
// inputs were found" diagnostic (TS18003) to its own `.errors` array -
// this function already discards `.errors`, keeping only `.options`, so
// that diagnostic never reaches a caller either way.
const noExpandParseConfigHost: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: (p) => ts.sys.fileExists(p),
  readFile: (p) => ts.sys.readFile(p),
};

function readCompilerOptions(configPath: string): ts.CompilerOptions {
  const { config } = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  // basePath = the config's own directory - a leaf tsconfig's own `paths`
  // (a per-package alias, e.g. "@/*": ["./src/*"]) resolves relative to
  // THIS, not the project root; parseJsonConfigFileContent computes
  // `pathsBasePath` from it. Hand-merging option objects instead of
  // reusing this real TypeScript call would resolve `paths` against the
  // wrong root and produce a different wrong answer, not a correct one.
  return ts.parseJsonConfigFileContent(config, noExpandParseConfigHost, dirname(configPath)).options;
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
// This function serves two callers with the same per-file need. The edge
// walk uses it to resolve each specifier through its own file's nearest
// tsconfig. Rule 6's own closure Program (`ensureProgram`, via
// `resolveModuleNameLiterals`) uses it too, by design: a leaf package's
// own aliased import (a monorepo path alias a nested tsconfig's own
// `paths` defines, differently from the root) resolves there too; a
// plain `ts.createProgram` call under the root options alone cannot see
// a nested tsconfig at all. One real,
// intentional difference this leaves standing: `target`/`jsx` still
// come from the root options for the whole Program (mixing genuinely
// incompatible per-file compilation targets into one shared Program is a
// separate architectural question, not attempted here) - only module
// resolution is per-file. The same holds for each file's ESM/CJS format
// inside that Program: TypeScript derives it from the root options, while
// the edge walk derives it from the file's own nearest tsconfig, so a
// nested tsconfig that overrides `module`/`moduleResolution` can make the
// two disagree on which export condition applies.
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
  // One walk produces the analyzed file list and the non-TS source count
  // every caller needs, plus the resolvable-file set, the package.json
  // list, and the node_modules directories found by descent - the three
  // extra ones only buildModuleGraphForRules' own resolutionInputs reads,
  // at no extra walk cost to a caller (simulate, fix, search) that never
  // touches them.
  const dtsSurfaceGlobs = surfaceGlobsAllowingDts(declaredModules, projectRoot, surface);
  const tree = walkProjectTree(projectRoot, exclude, dtsSurfaceGlobs);
  let rootNames = tree.analyzedFiles;
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

  return { projectRoot, surface, rootDir, rootNames, modules, resolveModuleForFile, compilerOptions, compilerOptionsForFile,
    nonTsSourceFileCount: tree.nonTsSourceFileCount, resolvableFiles: tree.resolvableFiles,
    packageJsonFiles: tree.packageJsonFiles, nodeModulesDirs: tree.nodeModulesDirs };
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
  // undefined moduleKind vs resolutionMode strings: same TS enum
  // (ResolutionMode is ModuleKind.CommonJS | ModuleKind.ESNext |
  // undefined) - undefined under a resolution strategy that does not
  // vary by usage (classic, and node10/"node" without package.json
  // exports/imports resolution), and defined under node16/nodenext and
  // bundler, which pick export conditions by it. Computed here,
  // from the real AST node (the one place that still has it - see this
  // module's own header on staying AST-free past this walk), so the
  // resolver never re-parses a file just to learn a specifier's own mode.
  mode: ts.ResolutionMode;
};

export type ModuleAugmentationSpecifier = {
  specifier: string;
  mode: ts.ResolutionMode;
};

export type FileImportWalk = {
  imports: ImportRecord[];
  unsupportedSyntaxCount: number;
  // Both read by type-closure.ts's own ambient-root rule (R6): a file
  // with neither import nor export binds its own top-level names into
  // the global scope, the same as a `declare global` or a
  // `declare module "literal name"` body does from inside a real module.
  // Computed once here, from real syntax, so the closure never re-parses
  // a file just to answer this - see walkFileImports' own header.
  isScript: boolean;
  hasAmbientDeclarations: boolean;
  // A module augmentation can add names outside a focused Program. A later
  // reparse is refused because this walk already has the required syntax.
  hasModuleAugmentation: boolean;
  // The guard resolves only these syntax-owned targets. Treating every
  // augmentation as local is refused because external packages are common.
  moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
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

// The per-file half of the edge walk: every import/export/dynamic-import/
// import-type specifier syntax recognizes, plus a count of syntax it doesn't
// (require(), import x = require(...)) - no resolution, no Program, no
// module graph. Kept separate from buildPreparedGraph's own resolution
// loop below so warm-graph.ts can memoize exactly this part.
// `compilerOptions` is this file's own effective options (compilerOptionsForFile,
// not necessarily the project root's) - passed through unchanged to
// ts.getModeForUsageLocation for every specifier, so the mode recorded
// here is the same one the resolver (buildPreparedGraph's own
// resolveModule) will resolve that same specifier under. `sf` must have
// been parsed with `setParentNodes: true`: getModeForUsageLocation reads
// `usage.parent` (and, for `import type ... with { "resolution-mode" }`,
// `usage.parent.parent`) - measured directly, a parent-less literal makes
// it throw rather than return undefined.
export function walkFileImports(sf: ts.SourceFile, compilerOptions: ts.CompilerOptions): FileImportWalk {
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
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      // `import("./x").Y` in a type position: a real type dependency on
      // the target file, not syntax that merely mentions a module name.
      // Recorded as type-only (never dynamic - "dynamic" here means the
      // runtime `import()` expression, which this is not) so rule 1
      // (public-surface bypass) and the edge constraints see it; without
      // this, `import("../b/internal.js").T` reached past a surface unseen.
      specifier = node.argument.literal;
      isTypeOnly = true;
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
        mode: ts.getModeForUsageLocation(sf, specifier, compilerOptions),
      });
    }

    ts.forEachChild(node, walk);
  });

  const isScript = !ts.isExternalModule(sf);
  const hasAmbientDeclarations = sf.statements.some((statement) =>
    isGlobalAugmentationOrAmbientModule(statement) || (isScript && isTopLevelDeclaration(statement)));
  // A script's string-named declaration defines an ambient module. Recording
  // it as an augmentation is refused because the script is already a root.
  const moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[] = [];
  if (!isScript) {
    for (const statement of sf.statements) {
      if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue;
      moduleAugmentationSpecifiers.push({
        specifier: statement.name.text,
        mode: ts.getModeForUsageLocation(sf, statement.name, compilerOptions),
      });
    }
  }
  return {
    imports, unsupportedSyntaxCount, isScript, hasAmbientDeclarations,
    hasModuleAugmentation: moduleAugmentationSpecifiers.length > 0,
    moduleAugmentationSpecifiers,
  };
}

// Parses one file and walks it for imports, in one place both real parse
// paths (buildPreparedGraph's own default walk, and warm-graph.ts's own
// cached one) call, so both compute the same resolution mode the same
// way. `impliedNodeFormat` (needed before the mode of any specifier
// inside can be known - see walkFileImports' own header) depends on the
// nearest package.json's own "type" field for a .ts/.tsx/.js/.jsx file
// (fixed by extension alone for .mts/.cts/.mjs/.cjs); `host` supplies the
// fileExists/readFile that lookup needs, and `packageJsonInfoCache`
// (a ts.ModuleResolutionCache's own getPackageJsonInfoCache(), or
// undefined) lets a caller that already has one avoid re-reading the
// same package.json for every ambiguous file - undefined costs an extra
// read per such file, never a wrong answer. `setExternalModuleIndicator`
// is deliberately NOT set here (unlike a real ts.Program, which sets it
// via getSetExternalModuleIndicator): that indicator, not
// impliedNodeFormat, decides `isScript` (via ts.isExternalModule) for a
// file with no import/export syntax of its own, and setting it would
// reclassify an import-less "type": "module" file as a module in a way
// this fix's own scope (resolution mode only - see this module's header)
// must not touch.
export function parseFileForImports(
  fileName: string,
  text: string,
  languageVersion: ts.ScriptTarget,
  host: ts.ModuleResolutionHost,
  compilerOptions: ts.CompilerOptions,
  packageJsonInfoCache: ts.PackageJsonInfoCache | undefined,
): FileImportWalk {
  const impliedNodeFormat = ts.getImpliedNodeFormatForFile(fileName, packageJsonInfoCache, host, compilerOptions);
  const sf = ts.createSourceFile(fileName, text, { languageVersion, impliedNodeFormat }, true, scriptKindForFile(fileName));
  return walkFileImports(sf, compilerOptions);
}

// `declare global { ... }` (GlobalAugmentation) or `declare module "literal
// name"` (a StringLiteral name) - binds names no import ever names,
// unlike a plain `namespace X {}`/`declare namespace X {}` (an Identifier
// name), which is an ordinary, reachable local declaration.
function isGlobalAugmentationOrAmbientModule(statement: ts.Statement): boolean {
  return ts.isModuleDeclaration(statement) &&
    (statement.name.kind === ts.SyntaxKind.StringLiteral || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);
}

// Every top-level statement shape type-closure.ts's own per-file summary
// treats as a named declaration - mirrored here only to decide whether a
// script file actually binds anything into the global scope, not to
// summarize its own references (that stays type-closure.ts's own job).
function isTopLevelDeclaration(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) ||
    ts.isVariableStatement(statement) ||
    (ts.isImportEqualsDeclaration(statement) && !ts.isExternalModuleReference(statement.moduleReference));
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
  // Test-only: forces `ensureProgram`'s own round loop to keep finding a
  // (fake) missing file forever, so a test can exercise the round bound
  // and the whole-project fallback without needing a closure rule gap
  // that genuinely never resolves - not part of BuildOptions, and never
  // read outside this module.
  forceClosureFallbackForTests?: boolean;
  // Test-only: simulates a genuine gap in type-closure.ts's own rules by
  // removing these files from the closure on round 0 only - a later
  // round, once the safety net reports the resulting unresolved alias
  // and resolves it through the edge records, adds them back for real.
  // Never read outside this module.
  dropFromClosureForTests?: readonly string[];
  // Test-only: called once per closure round with that round's own round
  // number and closure file list, so a test can assert on the round-by-
  // round shape itself (which files a round dropped, whether a later
  // round actually ran) through this seam instead of guessing it from the
  // final graph alone. Never read outside this module.
  onClosureRoundForTests?: (round: number, closureFiles: readonly string[]) => void;
};

// A file's own ambient and augmentation flags (walkFileImports' own header) -
// exposed only for the edge cache and the focused rule 6 safety guard.
// The public ModuleGraph shape does not expose these syntax details.
export type PreparedModuleGraph = ModuleGraph & {
  fileFlags: ReadonlyMap<string, {
    isScript: boolean;
    hasAmbientDeclarations: boolean;
    hasModuleAugmentation: boolean;
    moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
  }>;
};

// Everything a graph build needs that does NOT depend on which files were
// actually walked or how their specifiers resolved - built once per build
// (cold or cache-backed) and shared by the per-file walk, the disk-cache
// reconciliation (module-graph.ts's own buildModuleGraphForRules), and
// ensureProgram's own closure host, so all three resolve the same
// specifier under the same file's own nearest tsconfig the same way.
type GraphCommons = {
  host: ts.CompilerHost;
  resolutionCacheFor(options: ts.CompilerOptions): ts.ModuleResolutionCache;
  optionsForContainingFile(containingFile: string, redirectedReference?: ts.ResolvedProjectReference): ts.CompilerOptions;
  resolveModule(specifier: string, containingFile: string, mode: ts.ResolutionMode, redirectedReference?: ts.ResolvedProjectReference): ts.ResolvedModuleWithFailedLookupLocations;
  analyzedSet: ReadonlySet<string>;
  defaultFileWalk(fileName: string): FileImportWalk | undefined;
};

function makeGraphCommons(prepared: ReturnType<typeof prepareGraph>, overrides: GraphBuildOverrides): GraphCommons {
  const { rootNames, compilerOptions, compilerOptionsForFile } = prepared;
  const host = overrides.host ?? ts.createCompilerHost(compilerOptions);
  const languageVersion = compilerOptions.target ?? ts.ScriptTarget.ESNext;

  // One ts.ModuleResolutionCache per distinct compiler-options object
  // (a monorepo can have many, one per leaf tsconfig - see
  // compilerOptionsForFile's own comment), unless the caller supplies one
  // cache to use for every file regardless of its own options
  // (overrides.resolutionCache - simulate.ts's own single-cache-per-run
  // convention, kept as-is here). Always returns a real cache (never
  // undefined) - every branch below produces one - so a caller needing
  // its own getPackageJsonInfoCache() (parseFileForImports' own
  // impliedNodeFormat lookup) can call it directly, with no extra
  // plumbing for a case that cannot happen.
  const resolutionCaches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const resolutionCacheFor = (options: ts.CompilerOptions): ts.ModuleResolutionCache => {
    if (overrides.resolutionCache !== undefined) return overrides.resolutionCache;
    let cache = resolutionCaches.get(options);
    if (cache === undefined) {
      cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, options);
      resolutionCaches.set(options, cache);
    }
    return cache;
  };

  const defaultFileWalk = (fileName: string): FileImportWalk | undefined => {
    const text = host.readFile(fileName);
    if (text === undefined) return undefined;
    const options = compilerOptionsForFile(fileName);
    return parseFileForImports(fileName, text, languageVersion, host, options, resolutionCacheFor(options).getPackageJsonInfoCache());
  };

  // Every specifier resolution in this build goes through this one
  // function - the edge walk below, and (via optionsForContainingFile)
  // both branches of ensureProgram's own closureHost. `mode` decides
  // which of a dual package's own "import"/"require" export condition
  // (or a condition-scoped "types") applies under node16/nodenext; the
  // caller supplies it because only the caller has the real usage site
  // (an ImportRecord already carrying its own mode, or a live AST literal
  // node) getModeForUsageLocation needs to compute it - see
  // walkFileImports' own header for where that happens for an analyzed
  // file's own specifier.
  const analyzedSet = new Set(rootNames);
  const optionsForContainingFile = (containingFile: string, redirectedReference?: ts.ResolvedProjectReference): ts.CompilerOptions =>
    analyzedSet.has(containingFile) ? compilerOptionsForFile(containingFile) : (redirectedReference?.commandLine.options ?? compilerOptions);
  const resolveModule = (
    specifier: string,
    containingFile: string,
    mode: ts.ResolutionMode,
    redirectedReference?: ts.ResolvedProjectReference,
  ): ts.ResolvedModuleWithFailedLookupLocations => {
    const options = optionsForContainingFile(containingFile, redirectedReference);
    return ts.resolveModuleName(specifier, containingFile, options, host, resolutionCacheFor(options), redirectedReference, mode);
  };

  return { host, resolutionCacheFor, optionsForContainingFile, resolveModule, analyzedSet, defaultFileWalk };
}

// One import's own edge (or the reason it has none yet) - shared by the
// cold, always-resolve walk below and buildModuleGraphForRules' own
// disk-cache reconciliation, so a builtin and an external-package edge
// are built identically whichever path produced the underlying
// resolution. `resolution` is `undefined` for a builtin (no real
// resolvedFile - the specifier itself, "node:"-stripped, stands in for
// one) and the caller-supplied resolved outcome (or "unresolved")
// otherwise.
function edgeFor(
  fileName: string,
  fromModule: string,
  imp: ImportRecord,
  resolution: { resolvedFile: string; isExternalLibraryImport?: true; packageName?: string } | "unresolved" | undefined,
  resolveModuleForFile: (filePath: string) => string | undefined,
  projectRoot: string,
): { edge: Edge } | { unresolvedSpecifier: string } | undefined {
  const builtin = builtinModuleName(imp.specifier);
  if (builtin !== undefined) {
    return { edge: {
      fromFile: fileName, fromModule, fromPosition: imp.fromPosition, specifier: imp.specifier,
      isTypeOnly: imp.isTypeOnly, isDynamic: imp.isDynamic, resolvedFile: `node:${builtin}`, toModule: undefined, externalPackage: builtin,
    } };
  }
  if (resolution === undefined || resolution === "unresolved") return { unresolvedSpecifier: imp.specifier };
  const { resolvedFile } = resolution;
  const toModule = resolveModuleForFile(resolvedFile);
  const externalPackage = resolution.isExternalLibraryImport && !isWorkspaceSiblingResolution(resolvedFile, projectRoot)
    ? (resolution.packageName ?? imp.specifier.replace(/^node:/, "")) : undefined;
  return { edge: {
    fromFile: fileName, fromModule, fromPosition: imp.fromPosition, specifier: imp.specifier,
    isTypeOnly: imp.isTypeOnly, isDynamic: imp.isDynamic, resolvedFile, toModule, externalPackage,
  } };
}

type WalkResult = {
  edges: Edge[];
  outsideFiles: string[];
  // Read by type-closure.ts's own ambient-root rule - every analyzed
  // file's own two flags (walkFileImports' own header), regardless of
  // module membership: an ambient file binds names no import ever names,
  // whether or not any declared module claims it.
  fileFlags: Map<string, {
    isScript: boolean;
    hasAmbientDeclarations: boolean;
    hasModuleAugmentation: boolean;
    moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
  }>;
  unsupportedSyntaxCount: number;
  unresolvedSpecifierCount: number;
  unresolvedSpecifiers: string[];
};

// The cold, always-resolve walk: every rootName is parsed (via `fileWalk`)
// and every one of its specifiers is resolved through `commons.resolveModule`,
// with no cache of any kind consulted. buildModuleGraphForRules' own
// disk-cache reconciliation walks the identical rootNames list but skips
// this function entirely for a file whose parse and resolutions are both
// still valid.
function walkAllFiles(prepared: ReturnType<typeof prepareGraph>, commons: GraphCommons, fileWalk: (fileName: string) => FileImportWalk | undefined): WalkResult {
  const { rootNames, modules, resolveModuleForFile, projectRoot } = prepared;
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
  const fileFlags = new Map<string, {
    isScript: boolean;
    hasAmbientDeclarations: boolean;
    hasModuleAugmentation: boolean;
    moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
  }>();

  for (const fileName of rootNames) {
    const walked = fileWalk(fileName);
    if (walked === undefined) continue; // unreadable: invisible, matching a Program that never got a SourceFile for it either
    fileFlags.set(fileName, {
      isScript: walked.isScript,
      hasAmbientDeclarations: walked.hasAmbientDeclarations,
      hasModuleAugmentation: walked.hasModuleAugmentation,
      moduleAugmentationSpecifiers: walked.moduleAugmentationSpecifiers,
    });

    const fromModule = resolveModuleForFile(fileName);
    if (fromModule === undefined) {
      outsideFiles.push(fileName);
      continue;
    }
    modules.get(fromModule)?.files.push(fileName);
    unsupportedSyntaxCount += walked.unsupportedSyntaxCount;

    for (const imp of walked.imports) {
      // Resolved regardless of a leading "." - a bare specifier
      // (`@internal/a`, `lodash`) is resolved the same way a relative
      // one is; TS's own resolver already follows a workspace
      // package's package.json `exports` under nodenext, so the only
      // thing gating that path before was this project's own code,
      // not TypeScript.
      const builtin = builtinModuleName(imp.specifier);
      const resolution = builtin !== undefined ? undefined : (() => {
        const resolved = commons.resolveModule(imp.specifier, fileName, imp.mode);
        const rm = resolved.resolvedModule;
        return rm === undefined ? ("unresolved" as const) : {
          resolvedFile: rm.resolvedFileName,
          ...(rm.isExternalLibraryImport ? { isExternalLibraryImport: true as const } : {}),
          ...(rm.packageId?.name !== undefined ? { packageName: rm.packageId.name } : {}),
        };
      })();
      const outcome = edgeFor(fileName, fromModule, imp, resolution, resolveModuleForFile, projectRoot);
      if (outcome !== undefined && "edge" in outcome) edges.push(outcome.edge);
      else if (outcome !== undefined) { unresolvedSpecifierCount++; unresolvedSpecifiers.push(outcome.unresolvedSpecifier); }
    }
  }

  return { edges, outsideFiles, fileFlags, unsupportedSyntaxCount, unresolvedSpecifierCount, unresolvedSpecifiers };
}

// The rest of a graph build - crossModuleEdges and the lazy Program/rule-6
// closure - shared verbatim by the cold walk (buildPreparedGraph) and the
// disk-cache reconciliation (buildModuleGraphForRules): both hand this the
// same shape (edges + fileFlags + counts), so ensureProgram's own closure
// never needs to know whether its input came from a fresh parse or a
// cache hit. Separate assemblers are refused because they can give rule 6
// different closure facts for cached and uncached graphs.
function assembleGraph(prepared: ReturnType<typeof prepareGraph>, commons: GraphCommons, walked: WalkResult, overrides: GraphBuildOverrides): PreparedModuleGraph {
  const { modules, surface, rootDir, rootNames, compilerOptions } = prepared;
  const { edges, outsideFiles, fileFlags, unsupportedSyntaxCount, unresolvedSpecifierCount, unresolvedSpecifiers } = walked;
  const { host, analyzedSet, optionsForContainingFile, resolveModule, resolutionCacheFor } = commons;

  const crossModuleEdges = edges.filter(
    (e) => e.toModule !== undefined && e.toModule !== e.fromModule,
  );

  // Bounded at 3 rounds. A later round only ever happens when the closure
  // built in round 0 (surfaces, export chains, type positions, inference,
  // ambient roots, and a dynamic `import(...)` reached while inferring)
  // still leaves rule 6 unable to resolve some alias it needs - a
  // specifier syntax type-closure.ts's own rules do not yet recognize,
  // not an ordinary project's own re-export depth (every rule already
  // follows a whole chain in its first pass). Each later round adds
  // exactly the files rule 6 just reported missing and tries again.
  // Three rounds leaves room for one such gap to itself reference one
  // more before the closure stabilizes, while keeping the fallback path
  // fast to reach when it doesn't stabilize at all.
  const MAX_CLOSURE_ROUNDS = 3;

  // Built only on first access to `program`/`checker`, and dropped again
  // by `releaseProgram` - see this module's own header and the
  // `ModuleGraph.program`/`releaseProgram` field comments for why.
  let program: ts.Program | undefined;
  let notes: string[] = [];
  // A reused graph can next serve an unscoped caller without a release.
  // Sharing `notes` is refused because scoped notes would leak across calls.
  let scopedNotes: string[] = [];
  let cachedTypeLeaks: TypeLeakViolation[] | undefined;
  // Both Program paths need identical edge resolutions. A second resolver map
  // is refused because separate answers could diverge from the graph's edges.
  const resolvedSpecifiers = new Map<string, Map<string, string>>();
  for (const edge of edges) {
    let perFile = resolvedSpecifiers.get(edge.fromFile);
    if (perFile === undefined) { perFile = new Map(); resolvedSpecifiers.set(edge.fromFile, perFile); }
    perFile.set(edge.specifier, edge.resolvedFile);
  }
  const readFile = (file: string): string | undefined => host.readFile(file);
  const languageVersion = compilerOptions.target ?? ts.ScriptTarget.ESNext;
  const baseHost = overrides.host ?? host;
  const ambientFiles = [...fileFlags].filter(([, f]) => f.isScript || f.hasAmbientDeclarations).map(([file]) => file);
  // Both Program paths require the same closure facts. A duplicated input
  // assembly is refused because ambient roots and resolutions must stay equal.
  const closureInputs = (surfaceFiles: readonly string[], extraRoots: readonly string[] = []): TypeClosureInputs => ({
    readFile, languageVersion, scriptKindFor: scriptKindForFile, ambientFiles,
    surfaceFiles, resolvedSpecifiers, extraRoots,
  });

  // Both Program paths need the same bounded safety loop. Separate loops are
  // refused because a missed alias must trigger the same fallback in each path.
  const runProgramRounds = (
    surfaceFiles: readonly string[],
    focusModuleName?: string,
    extraNamedDeclarationKeys?: ReadonlySet<string>,
  ): { program: ts.Program; violations?: TypeLeakViolation[]; notes: string[] } => {
    // The Program's own module-resolution host, not `noResolve`: `noResolve`
    // also stops TypeScript from following node_modules/@types imports and
    // triple-slash references, so an external dependency's own generic type
    // (Promise<Internal>, an npm package's own EventEmitter<Internal>, ...)
    // would resolve to an error type there, and a real finding through it
    // would silently disappear. `resolveModuleNameLiterals` instead resolves
    // every specifier exactly the way this module's own edge walk already
    // does (the file's own nearest tsconfig, the same per-options
    // resolution cache), then restricts only ONE case: a containing file
    // this project analyzes, resolving to ANOTHER file this project
    // analyzes that sits outside the closure, reads back as unresolved -
    // the checker sees exactly what it would see if that file did not
    // exist, which is the closure's whole premise. Every other case
    // (an external dependency's own file resolving its own further
    // imports, a project file resolving into node_modules/@types/lib) gets
    // the real result unfiltered, so that whole external graph loads the
    // same way it would in a whole-project Program - triple-slash
    // references and automatic type-directive inclusion are untouched,
    // TypeScript's own defaults for both.
    function closureHost(closureSet: ReadonlySet<string>): ts.CompilerHost {
      const delegate: ts.CompilerHost = Object.create(baseHost);
      // `containingSourceFile` comes from the Program itself, already
      // carrying the correct `impliedNodeFormat` (Program's own
      // getCreateSourceFileOptions computes it before ever calling
      // host.getSourceFile - untouched by this delegate, which never
      // overrides getSourceFile) - so getModeForUsageLocation reads a
      // real, correctly-tagged file here, the same as it would inside a
      // default (no resolveModuleNameLiterals override) ts.createProgram
      // call. The 4th positional param (TS's own per-call options,
      // accounting for a redirected project reference) is not used here:
      // optionsForContainingFile derives the equivalent value itself, and
      // this project never sets up project references for the two to
      // disagree over.
      delegate.resolveModuleNameLiterals = (moduleLiterals, containingFile, redirectedReference, _options, containingSourceFile) =>
        moduleLiterals.map((literal) => {
          const options = optionsForContainingFile(containingFile, redirectedReference);
          const mode = ts.getModeForUsageLocation(containingSourceFile, literal, options);
          const resolved = resolveModule(literal.text, containingFile, mode, redirectedReference);
          if (!analyzedSet.has(containingFile)) return resolved;
          const resolvedFile = resolved.resolvedModule?.resolvedFileName;
          if (resolvedFile !== undefined && analyzedSet.has(resolvedFile) && !closureSet.has(resolvedFile)) {
            return { ...resolved, resolvedModule: undefined };
          }
          return resolved;
        });
      // With resolveModuleNameLiterals overridden, createProgram takes its
      // package.json and module-format cache from getModuleResolutionCache.
      // Without one, it re-reads and re-parses the nearest package.json for
      // every file's format and keeps a copy per SourceFile: on a 23,000-file
      // project with a 145 KB root package.json, that cost about 550 MB of a
      // full check. The root options' cache is the one the edge walk already
      // filled.
      delegate.getModuleResolutionCache = () => resolutionCacheFor(compilerOptions);
      return delegate;
    }

    let extraRoots: string[] = [];
    for (let round = 0; ; round++) {
      const closure = buildTypeClosure(closureInputs(surfaceFiles, extraRoots));
      // Test-only: see GraphBuildOverrides' own comment. Round 0 only -
      // a later round's own `extraRoots` (added for real, by the safety
      // net below) must stick.
      const dropped = round === 0 ? new Set(overrides.dropFromClosureForTests ?? []) : undefined;
      const closureFiles = dropped === undefined ? closure.files : closure.files.filter((f) => !dropped.has(f));
      overrides.onClosureRoundForTests?.(round, closureFiles);
      const closureSet = new Set(closureFiles);
      const candidate = ts.createProgram({
        rootNames: closureFiles, options: compilerOptions,
        host: closureHost(closureSet), oldProgram: overrides.oldProgram,
      });
      // The safety net: rule 6 itself is the only code that already
      // walks every alias and every structural type a surface (or an
      // internal declaration) depends on, so its own resolution failures
      // are read back here instead of this module re-deriving them - a
      // real, deliberate exception to this module's own "no rule logic
      // here" boundary (see the header). An unresolved alias names the
      // specifier it failed on - resolved from the same edge records the
      // closure itself used, no re-resolution.
      //
      // The unscoped caller caches this return value as `cachedTypeLeaks`.
      // The focused caller returns it directly. Neither caller walks the
      // identical final Program a second time after a successful round.
      const missing = new Set<string>();
      const roundViolations = checkTypeLeaks({ modules, program: candidate, checker: candidate.getTypeChecker(), rootDir }, {
        focusModuleName,
        extraNamedDeclarationKeys,
        report: ({ file, specifier }) => {
          const resolved = resolvedSpecifiers.get(file)?.get(specifier);
          if (resolved !== undefined && analyzedSet.has(resolved) && !closureSet.has(resolved)) missing.add(resolved);
        },
      });
      // Test-only: see GraphBuildOverrides' own comment. The value added
      // is never a real file - only `missing.size` past this point
      // matters, not what it names.
      if (overrides.forceClosureFallbackForTests === true) missing.add("\0forced-missing-for-tests");
      // A complete alias walk makes the candidate safe. Another round is
      // refused because another round adds work without a missing root.
      if (missing.size === 0) return { program: candidate, violations: roundViolations, notes: [] };
      if (round >= MAX_CLOSURE_ROUNDS) {
        // The bound prevents an unending recovery loop. A partial result is
        // refused because an omitted public name creates a false leak.
        return {
          notes: [`rule 6's type closure could not resolve every referenced import after ${MAX_CLOSURE_ROUNDS} rounds; fell back to the whole-project program for this check`],
          program: ts.createProgram({ rootNames, options: compilerOptions, host: baseHost, oldProgram: overrides.oldProgram }),
        };
      }
      extraRoots = [...extraRoots, ...missing];
    }
  };

  // Unscoped callers share one Program and cache. Reusing a focused Program is
  // refused because an MCP caller can request an unscoped answer on the graph.
  const ensureProgram = (): ts.Program => {
    // Unscoped callers share the memoized Program. Rebuilding the Program is refused
    // because it repeats binding work without changing the requested scope.
    if (program !== undefined) return program;
    const built = runProgramRounds([...modules.values()].flatMap((m) => m.surfaceFiles));
    program = built.program;
    notes = built.notes;
    cachedTypeLeaks = built.violations;
    return program;
  };

  // A project-file augmentation can add names outside the focused closure.
  // Falling back for external targets is refused because they add no project name.
  function hasAnalyzedModuleAugmentation(): boolean {
    for (const [file, flags] of fileFlags) {
      for (const augmentation of flags.moduleAugmentationSpecifiers) {
        const target = resolveModule(augmentation.specifier, file, augmentation.mode).resolvedModule?.resolvedFileName;
        if (target !== undefined && analyzedSet.has(target)) return true;
      }
    }
    return false;
  }

  const graph: PreparedModuleGraph = {
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
      notes = [];
      // A release ends both result lifetimes. Retaining scoped notes is refused
      // because a later focused call can have a different fallback reason.
      scopedNotes = [];
      cachedTypeLeaks = undefined;
    },
    get programNotes() {
      return notes;
    },
    get focusedTypeLeakNotes() {
      // The getter exposes notes assembled for the latest focused call.
      // Returning `notes` directly is refused because it lacks scoped reasons.
      return scopedNotes;
    },
    get cachedTypeLeaks() {
      return cachedTypeLeaks;
    },
    typeLeaksForFocus(moduleName: string) {
      const module = modules.get(moduleName);
      // A missing module has no surface roots. Building an unscoped Program is
      // refused because it cannot produce a finding owned by the missing module.
      if (module === undefined) return [];
      // Other surfaces contribute public names, but their closures are omitted.
      // Loading the other closures is refused because full loading recreates the measured cost.
      const otherSurfaceFiles = [...modules.values()]
        .filter((candidate) => candidate.name !== moduleName)
        .flatMap((candidate) => candidate.surfaceFiles);
      const named = computeSyntacticNamedDeclarations(closureInputs(otherSurfaceFiles), otherSurfaceFiles);
      // An unresolved export chain can hide a public name. Continuing with a
      // partial key set is refused because the omitted name creates a false leak.
      const fallbackReason = named.unresolvable
        ? "the syntactic public-name resolver could not resolve every declaration"
        // An analyzed augmentation can add a name absent from surface syntax.
        // Continuing with syntactic keys is refused because the name stays invisible.
        : hasAnalyzedModuleAugmentation()
          ? "an analyzed module augmentation can add public names"
          : undefined;
      if (fallbackReason !== undefined) {
        // The unscoped checker supplies every name and the note exposes the cost.
        // Silent scoped evaluation is refused because it can report a false leak.
        const focusedNote = `rule 6 could not safely scope this surface because ${fallbackReason}; fell back to the whole-project type closure for this check`;
        const violations = checkTypeLeaks(graph).filter((violation) => violation.todoModule === moduleName);
        // The whole-project builder can add its own fallback note. Dropping it is
        // refused because the focused result must explain every fallback it used.
        scopedNotes = [focusedNote, ...notes];
        return violations;
      }
      const built = runProgramRounds(module.surfaceFiles, moduleName, named.keys);
      scopedNotes = built.notes;
      // A successful round already returns its findings. Rewalking is refused
      // unless the bounded fallback returns only a whole-project Program.
      const violations = built.violations ?? checkTypeLeaks({
        modules, program: built.program, checker: built.program.getTypeChecker(), rootDir,
      }, { focusModuleName: moduleName, extraNamedDeclarationKeys: named.keys });
      return violations;
    },
    fileFlags,
  };
  return graph;
}

export function buildPreparedGraph(prepared: ReturnType<typeof prepareGraph>, overrides: GraphBuildOverrides = {}): PreparedModuleGraph {
  const commons = makeGraphCommons(prepared, overrides);
  const walked = walkAllFiles(prepared, commons, overrides.fileWalk ?? commons.defaultFileWalk);
  return assembleGraph(prepared, commons, walked, overrides);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const ARCHSTRICT_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// A hash of the two built files whose own code produces a cache entry
// (this file and edge-cache.ts, read from beside `import.meta.url` - the
// same directory a build writes both to), computed once per process. A
// package version bump is not the only way this project's own walker or
// resolver logic changes: a local build after an uncommitted edit to
// either file changes neither ARCHSTRICT_VERSION nor the package.json
// this process reads, but does change what a cache entry means - reading
// an old entry back under new code would replay an answer the new code
// never produced. Read once, not per build: neither file's own content
// changes while one process is running.
const CODE_VERSION_HASH: string = (() => {
  try {
    const sources = ["module-graph.js", "edge-cache.js"].map((name) => readFileSync(new URL(name, import.meta.url), "utf8"));
    return createHash("sha256").update(sources.join("\u0000")).digest("hex");
  } catch {
    // A test importing this module from its own .ts source (never built
    // to module-graph.js/edge-cache.js beside it) has no built files to
    // hash - a fixed placeholder, not a crash, since this only ever
    // gates a cache write/read this same process makes and reads back.
    return "unbuilt";
  }
})();

// The exact typescript this process resolved, next to CODE_VERSION_HASH:
// a different installed typescript version can resolve or parse the same
// project differently (a resolver bug fix, a new export-condition rule)
// with neither this project's own code nor its package.json version
// having changed at all.
const TYPESCRIPT_VERSION: string = ts.version;

function cacheMetadata(projectRoot: string, options: BuildOptions): Record<string, number | null> {
  const packages = [join(projectRoot, "package.json"), ...options.declaredModules
    .map((dm) => join(projectRoot, moduleGlobBaseDir(dm.glob), "package.json"))];
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]
    .map((name) => join(projectRoot, name)).find((path) => existsSync(path));
  if (lock !== undefined) packages.push(lock);
  return Object.fromEntries([...new Set(packages)].sort().map((path) => [path, existsSync(path) ? statSync(path).mtimeMs : null]));
}

// Stringifies one distinct effective-options OBJECT at most once, keyed
// by reference identity - compilerOptionsForFile memoizes per directory
// (not per file), so the same object recurs across many files. Keying
// solely by the JSON string would require producing that string first,
// which needs one stringify per file regardless of how many end up
// sharing a key. A project with one tsconfig then stringifies once, not
// once per file - the 14 KB-per-file churn a 23,000-file project would
// otherwise pay twice over (once here, once in buildModuleGraphForRules
// below).
function optionsJsonMemo() {
  const jsonByIdentity = new Map<ts.CompilerOptions, string>();
  return (opts: ts.CompilerOptions): string => {
    let json = jsonByIdentity.get(opts);
    if (json === undefined) { json = JSON.stringify(opts); jsonByIdentity.set(opts, json); }
    return json;
  };
}

// warm-graph.ts's own in-memory, single-process fingerprint - unrelated to
// the persistent disk cache below (see buildModuleGraphForRules' own
// header for that one's own, broader inputs). Kept as one opaque string
// per distinct effective options object, not one 14 KB options object
// repeated per file: a project with thousands of files but a handful of
// distinct tsconfigs hashes a handful of objects, not one per file - the
// same dedup technique the disk cache uses (below).
export function graphBuildFingerprint(options: BuildOptions, prepared: ReturnType<typeof prepareGraph>) {
  const { projectRoot, rootNames, compilerOptions, compilerOptionsForFile } = prepared;
  const optionsJson = optionsJsonMemo();
  const optionsIndexByJson = new Map<string, number>();
  const optionsTable: string[] = [];
  const fileOptionsIndex = rootNames.map((file) => {
    const json = optionsJson(compilerOptionsForFile(file));
    let idx = optionsIndexByJson.get(json);
    if (idx === undefined) { idx = optionsTable.length; optionsTable.push(json); optionsIndexByJson.set(json, idx); }
    return idx;
  });
  const tsconfigHash = hash({ root: compilerOptions, optionsTable, fileOptionsIndex });
  const buildOptionsHash = hash({ declaredModules: options.declaredModules,
    exclude: options.exclude, surface: prepared.surface });
  const metadata = cacheMetadata(projectRoot, options);
  return { tsconfigHash, buildOptionsHash, metadata, archstrictVersion: ARCHSTRICT_VERSION };
}

const LOCKFILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;

// The nearest lockfile above `startDir`, checked at `startDir` itself and
// then each ancestor up to the filesystem root - a monorepo's own
// lockfile commonly sits at the workspace root, one or more directories
// above any one package's own project root.
function findNearestLockfile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    for (const name of LOCKFILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Top-level package names (scoped names included, one entry per
// "@scope/name") directly under one node_modules directory, each paired
// with its own package.json's own mtime - read after following any
// symlink (`npm link`, or a workspace's own symlinked sibling package),
// since the real file such a symlink points at is what actually changes
// when that package's own `exports`/`imports` map is edited, not the
// symlink itself, whose own mtime a package manager does not always
// touch for that edit. Returns an empty object for a directory that does
// not exist (a project with no dependencies at all, or above the
// filesystem root's own node_modules that never exists).
function listNodeModulesPackages(nodeModulesDir: string): Record<string, number | null> {
  let entries: Dirent[];
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const names: string[] = [];
  for (const entry of entries) {
    // Never a real package: ".bin" (npm's own executable-symlink
    // directory), and every other dot-prefixed entry a package manager
    // or another tool creates for its own bookkeeping right inside
    // node_modules (".cache", ".vite", ".vitest", pnpm's own ".pnpm"
    // content-addressed store - a real package under it is reached
    // through a top-level symlink instead, counted there). Skipping
    // these keeps this project's own persistent cache from moving its
    // own fingerprint the moment it creates node_modules/.cache/archstrict.
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (entry.name.startsWith("@")) {
      let scoped: Dirent[];
      try {
        scoped = readdirSync(join(nodeModulesDir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (s.isDirectory() || s.isSymbolicLink()) names.push(`${entry.name}/${s.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return Object.fromEntries(
    names.sort().map((name) => {
      const packageJson = join(nodeModulesDir, name, "package.json");
      let mtime: number | null = null;
      try {
        mtime = statSync(realpathSync(packageJson)).mtimeMs;
      } catch {
        // A package directory with no package.json, or a broken symlink -
        // its own presence in `names` still moves the fingerprint.
        mtime = null;
      }
      return [name, mtime];
    }),
  );
}

// Every node_modules directory this project's own root, or an ancestor
// of it, has - up to the filesystem root, always, because that is how
// far TypeScript's own resolver walks for a bare specifier (measured
// directly: a package installed only into an ancestor directory's own
// node_modules, above any lockfile the project has, still resolves for
// real - a chain that stopped at the nearest lockfile's own directory
// missed exactly this). Covers a package installed or removed with no
// lockfile edit at all (no package.json under the project root moves
// either, and no lockfile exists to record it), and a symlinked
// workspace package's own `exports` edit. A node_modules directory
// nested INSIDE the project (a workspace member's own, e.g.
// packages/app/node_modules) is not an ancestor of the project root, so
// it is covered separately, by walkProjectTree's own descent - merged
// in here by the caller.
//
// Remaining limit, stated here and in this cache's own module header: an
// edit inside an already-installed package's own file (not its
// package.json) is invisible to every input this function reads - this
// cache has no way to notice it short of deleting
// node_modules/.cache/archstrict itself.
function ancestorNodeModulesDirs(projectRoot: string): string[] {
  const dirs: string[] = [];
  let dir = projectRoot;
  for (;;) {
    dirs.push(join(dir, "node_modules"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

// Every input a resolution answer (not a parse) depends on that this
// module cannot read off one file alone - see edge-cache.ts's own header
// for the full contract this feeds. `resolvableFiles`, `packageJsonFiles`,
// and `descendantNodeModulesDirs` all come from the one project-tree walk
// prepareGraph already did (walkProjectTree) - this function adds no
// directory walk of its own beyond the ancestor node_modules chain and
// each node_modules directory's own top level.
function resolutionInputs(
  projectRoot: string,
  rootNames: readonly string[],
  resolvableFiles: readonly string[],
  packageJsonFiles: readonly string[],
  descendantNodeModulesDirs: readonly string[],
) {
  const packages = Object.fromEntries(
    [...packageJsonFiles].sort().map((path) => [path, statSync(path).mtimeMs]),
  );
  const lockPath = findNearestLockfile(projectRoot);
  const lockMtime = lockPath === undefined ? null : statSync(lockPath).mtimeMs;
  // Hashed once, not embedded file-by-file: an added, deleted, or renamed
  // file changes this one hash, not a per-file field every other file's
  // own entry would otherwise have to repeat.
  const filesHash = hash([...rootNames].sort());
  // Existence only, never mtime: a resolvable file's own content never
  // changes what it resolves to (it is never parsed or read for that
  // purpose) - only whether it exists at all does.
  const resolvableFilesHash = hash([...resolvableFiles].sort());
  const nodeModuleDirs = new Set([...ancestorNodeModulesDirs(projectRoot), ...descendantNodeModulesDirs]);
  const nodeModules = Object.fromEntries([...nodeModuleDirs].sort().map((dir) => [dir, listNodeModulesPackages(dir)]));
  return { packages, lockPath: lockPath ?? null, lockMtime, filesHash, resolvableFilesHash, nodeModules };
}

// One analyzed file's own reparse gate: true while this file's own text
// (mtime+size), its own nearest tsconfig's own effective options, and its
// own nearest package.json "type" (impliedNodeFormat - see edge-cache.ts's
// own header on why this is separate from the tsconfig check) all still
// match what was cached for it. False for either a brand-new file (no old
// entry) or one whose own inputs moved - the only two cases that force a
// reparse of this ONE file, never the rest of the project.
function fileParseValid(
  oldEntry: CachedFileEntry | undefined,
  stat: { mtimeMs: number; size: number } | undefined,
  optionsJson: string,
  oldOptionsTable: readonly string[],
  impliedNodeFormat: ts.ResolutionMode,
): oldEntry is CachedFileEntry {
  return oldEntry !== undefined && stat !== undefined &&
    oldEntry.mtimeMs === stat.mtimeMs && oldEntry.size === stat.size &&
    oldEntry.optionsIndex < oldOptionsTable.length && oldOptionsTable[oldEntry.optionsIndex] === optionsJson &&
    oldEntry.impliedNodeFormat === impliedNodeFormat;
}

// THE one graph-build path every verb that needs a real analysis reads
// and writes (check, check <file>, todo, rules, recommend, fix's own
// baseline, search - see each verb's own call site). Persists to
// node_modules/.cache/archstrict/edges.json (a header) plus its own
// edges/*.json shards, per file, keyed by absolute path once decoded -
// see edge-cache.ts's own header for the full correctness contract
// (which input invalidates which stored fact, and where) and for why the
// cache is sharded at all. Never touched by simulate.ts, which keeps its
// own in-memory overlay instead (a proposed, not-yet-real change has no
// business landing in a cache other commands would then read back as if
// it were real).
export function buildModuleGraphForRules(options: BuildOptions): ModuleGraph {
  const prepared = prepareGraph(options);
  const commons = makeGraphCommons(prepared, {});
  const { projectRoot, rootNames, modules, resolveModuleForFile, compilerOptionsForFile, resolvableFiles, packageJsonFiles, nodeModulesDirs } = prepared;
  const path = join(projectRoot, "node_modules/.cache/archstrict/edges.json");
  const cached = readEdgeCache(path, projectRoot);
  // A package version or code-version mismatch drops the whole cache -
  // modeled here as "no old entry for any file", which the per-file logic
  // below already treats as a full reparse+resolve of that file.
  const versionOk = cached !== undefined && cached.archstrictVersion === ARCHSTRICT_VERSION &&
    cached.codeVersionHash === CODE_VERSION_HASH && cached.typescriptVersion === TYPESCRIPT_VERSION;
  const oldOptionsTable = versionOk ? cached.optionsTable : [];

  // Every file's own effective options and implied module format - cheap
  // even on a large tree: compilerOptionsForFile memoizes per directory
  // (not per file), and ts.getImpliedNodeFormatForFile reads only the
  // nearest package.json, cached the same way. optionsJson is keyed by
  // the options OBJECT's own identity (see optionsJsonMemo's own header) -
  // never restringified for two files sharing one directory's tsconfig.
  const optionsJson = optionsJsonMemo();
  const optionsIndexByJson = new Map<string, number>();
  const optionsTable: string[] = [];
  const optionsJsonByFile = new Map<string, string>();
  const optionsIndexByFile = new Map<string, number>();
  const impliedFormatByFile = new Map<string, ts.ResolutionMode>();
  for (const file of rootNames) {
    const opts = compilerOptionsForFile(file);
    const json = optionsJson(opts);
    optionsJsonByFile.set(file, json);
    let idx = optionsIndexByJson.get(json);
    if (idx === undefined) { idx = optionsTable.length; optionsTable.push(json); optionsIndexByJson.set(json, idx); }
    optionsIndexByFile.set(file, idx);
    const packageJsonInfoCache = commons.resolutionCacheFor(opts).getPackageJsonInfoCache();
    impliedFormatByFile.set(file, ts.getImpliedNodeFormatForFile(file, packageJsonInfoCache, commons.host, opts));
  }

  const inputs = resolutionInputs(projectRoot, rootNames, resolvableFiles, packageJsonFiles, nodeModulesDirs);
  const fingerprint = hash({ ...inputs, optionsTable });
  // Whether every file's own already-cached resolutions can be reused
  // outright, with no ts.resolveModuleName call at all - false forces a
  // fresh resolve of every specifier (from each file's own, possibly still
  // cached, `imports`), never a reparse of every file.
  const resolutionsValid = versionOk && cached.resolutionFingerprint === fingerprint;

  const stats = new Map<string, { mtimeMs: number; size: number } | undefined>();
  for (const file of rootNames) {
    try { const st = statSync(file); stats.set(file, { mtimeMs: st.mtimeMs, size: st.size }); }
    catch { stats.set(file, undefined); }
  }

  const newFiles: EdgeCache["files"] = {};
  const edges: Edge[] = [];
  const outsideFiles: string[] = [];
  const fileFlags = new Map<string, {
    isScript: boolean;
    hasAmbientDeclarations: boolean;
    hasModuleAugmentation: boolean;
    moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
  }>();
  let unsupportedSyntaxCount = 0;
  let unresolvedSpecifierCount = 0;
  const unresolvedSpecifiers: string[] = [];
  // True once any file's own parse was not reused - a full hit (every
  // file's own parse AND the global resolution fingerprint both still
  // valid) needs no rewrite at all: the new cache would be byte-identical
  // to the one already on disk, and skipping the write leaves that file's
  // own mtime alone, so a caller comparing two back-to-back no-op builds
  // (or a snapshot of the project tree around one) sees no change either.
  let dirty = !versionOk || !resolutionsValid;
  // Every file whose own entry this build actually reparsed - the exact
  // set whose own shard (edge-cache.ts's own `shardIndexForRelativePath`)
  // must be rewritten when `forceAll` (below) is false. A file that only
  // had its resolutions refreshed (mustResolve true, parseValid true)
  // does not add itself here on purpose: `forceAll` already covers that
  // case for every file at once, the moment `resolutionsValid` is false.
  const dirtyPaths = new Set<string>();

  for (const file of rootNames) {
    const stat = stats.get(file);
    const oldEntry = versionOk ? cached.files[file] : undefined;
    const optionsIndex = optionsIndexByFile.get(file)!;
    const impliedNodeFormat = impliedFormatByFile.get(file);
    const parseValid = fileParseValid(oldEntry, stat, optionsJsonByFile.get(file)!, oldOptionsTable, impliedNodeFormat);
    if (!parseValid) { dirty = true; dirtyPaths.add(file); }

    let imports: ImportRecord[];
    let unsupportedForFile: number;
    let isScript: boolean;
    let hasAmbientDeclarations: boolean;
    let hasModuleAugmentation: boolean;
    let moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
    let unreadable: true | undefined;
    if (parseValid) {
      ({ imports, unsupportedSyntaxCount: unsupportedForFile, isScript, hasAmbientDeclarations,
        hasModuleAugmentation, moduleAugmentationSpecifiers, unreadable } = oldEntry);
    } else if (stat === undefined) {
      // Listed by the scan, gone (or unstattable) by the time this build
      // reached it - a race, not a real file to analyze this build.
      continue;
    } else {
      const walked = commons.defaultFileWalk(file);
      if (walked === undefined) {
        imports = []; unsupportedForFile = 0; isScript = false; hasAmbientDeclarations = false;
        hasModuleAugmentation = false; moduleAugmentationSpecifiers = []; unreadable = true;
      } else {
        ({ imports, unsupportedSyntaxCount: unsupportedForFile, isScript, hasAmbientDeclarations,
          hasModuleAugmentation, moduleAugmentationSpecifiers } = walked);
      }
    }

    if (unreadable) {
      // Invisible exactly like a cold walk treats it (module-graph.ts's
      // own header): joins neither a module's own `files` nor
      // `outsideFiles`, and carries no resolutions - there is nothing to
      // resolve for a file that was never really read.
      newFiles[file] = { mtimeMs: stat!.mtimeMs, size: stat!.size, optionsIndex,
        ...(impliedNodeFormat !== undefined ? { impliedNodeFormat } : {}),
        imports: [], unsupportedSyntaxCount: 0, isScript: false, hasAmbientDeclarations: false,
        hasModuleAugmentation: false, moduleAugmentationSpecifiers: [], unreadable: true, resolutions: {} };
      continue;
    }

    fileFlags.set(file, { isScript, hasAmbientDeclarations, hasModuleAugmentation, moduleAugmentationSpecifiers });
    const fromModule = resolveModuleForFile(file);
    if (fromModule === undefined) outsideFiles.push(file);
    else { modules.get(fromModule)?.files.push(file); unsupportedSyntaxCount += unsupportedForFile; }

    // Every walked file's own specifiers are resolved here, whether or
    // not it currently belongs to a declared module - a file outside
    // every module today can belong to one after a `declaredModules`
    // edit alone, with its own mtime, size, and resolution fingerprint
    // all unchanged; a resolution recorded only for module-owned files
    // would leave that file with no record at all, and reading a missing
    // key as "unresolved" below would misreport it as unresolved forever
    // instead of resolving it once, right here.
    //
    // A changed file's own specifiers are always re-resolved (mustResolve
    // is true whenever parseValid is false); otherwise, reused outright
    // while resolutionsValid, or freshly resolved (project-wide, but from
    // each file's own already-cached `imports`, never a reparse) the
    // moment any covered input moved. Either way, a specifier with no
    // prior record (this file's own membership changed, or any other
    // reason a key could be missing) is resolved here rather than assumed
    // unresolved - a cache entry records exactly the specifiers it
    // actually resolved, never a gap silently read back as a negative
    // answer.
    const mustResolve = !parseValid || !resolutionsValid;
    const priorResolutions: Record<string, CachedResolution> = parseValid ? oldEntry.resolutions : {};
    const resolutions: Record<string, CachedResolution> = {};
    for (const imp of imports) {
      const key = resolutionKey(imp);
      const builtin = builtinModuleName(imp.specifier);
      let resolution: CachedResolution | undefined;
      if (builtin === undefined) {
        if (!mustResolve && Object.hasOwn(priorResolutions, key)) {
          resolution = priorResolutions[key]!; // Object.hasOwn just confirmed this key is present
        } else {
          const resolved = commons.resolveModule(imp.specifier, file, imp.mode);
          const rm = resolved.resolvedModule;
          resolution = rm === undefined ? "unresolved" : {
            resolvedFile: rm.resolvedFileName,
            ...(rm.isExternalLibraryImport ? { isExternalLibraryImport: true as const } : {}),
            ...(rm.packageId?.name !== undefined ? { packageName: rm.packageId.name } : {}),
          };
        }
        resolutions[key] = resolution;
      }
      if (fromModule !== undefined) {
        const outcome = edgeFor(file, fromModule, imp, resolution, resolveModuleForFile, projectRoot);
        if (outcome !== undefined && "edge" in outcome) edges.push(outcome.edge);
        else if (outcome !== undefined) { unresolvedSpecifierCount++; unresolvedSpecifiers.push(outcome.unresolvedSpecifier); }
      }
    }

    // `stat` is defined here regardless of branch: `parseValid` requires
    // it (fileParseValid), and the reparse branch above already `continue`s
    // when it's undefined.
    newFiles[file] = { mtimeMs: stat!.mtimeMs, size: stat!.size, optionsIndex,
      ...(impliedNodeFormat !== undefined ? { impliedNodeFormat } : {}),
      imports, unsupportedSyntaxCount: unsupportedForFile, isScript, hasAmbientDeclarations,
      hasModuleAugmentation, moduleAugmentationSpecifiers, resolutions };
  }

  // Do not label an analysis with mtimes/sizes from a concurrent edit.
  const stillStable = rootNames.every((file) => {
    const before = stats.get(file);
    if (before === undefined) return false;
    try { const now = statSync(file); return now.mtimeMs === before.mtimeMs && now.size === before.size; }
    catch { return false; }
  });
  if (dirty && stillStable) {
    // Every file this build's own cache no longer has an entry for, but
    // the OLD cache did (deleted, renamed away from, or dropped by the
    // stat-race `continue` above) - its own shard must be rewritten too,
    // to drop that now-stale entry, even though nothing marked it dirty
    // above (there is no new entry to reparse).
    const deletedPaths = new Set<string>();
    if (versionOk) for (const oldPath of Object.keys(cached.files)) if (!Object.hasOwn(newFiles, oldPath)) deletedPaths.add(oldPath);
    writeEdgeCache(path, projectRoot,
      { archstrictVersion: ARCHSTRICT_VERSION, codeVersionHash: CODE_VERSION_HASH, typescriptVersion: TYPESCRIPT_VERSION, optionsTable, resolutionFingerprint: fingerprint, files: newFiles },
      versionOk ? cached.shards : undefined, dirtyPaths, deletedPaths, !versionOk || !resolutionsValid);
  }

  const walked: WalkResult = { edges, outsideFiles, fileFlags, unsupportedSyntaxCount, unresolvedSpecifierCount, unresolvedSpecifiers };
  return assembleGraph(prepared, commons, walked, {});
}
