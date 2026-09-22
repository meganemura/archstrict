// Responsibility: discover modules under a glob, build a TypeScript program
// over them, and resolve every import/export/dynamic-import edge to its
// target module. This is shared infrastructure: every rule (public-surface
// bypass, cycles, uncovered modules, deprecated edges) and every verb reads
// the same graph rather than each re-walking the program.
// Boundary: no rule logic here. A rule is a predicate over this graph's
// edges and modules; this module only builds the graph and says what it
// could not analyze (unresolved specifiers, unsupported syntax, files
// outside the modules glob) as counts, never as silence.
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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  dir: string;
  files: string[];
  // The module's public surface: the files other modules may import from.
  // Under v0 discovery this is at most one file (the configured `surface`
  // name, e.g. "index.ts", if present - an empty array otherwise). Under a
  // declared module (v1), `surface` is itself a glob, so this can be more
  // than one file (Prisma's package.json `exports` has subpaths) - sorted,
  // for a deterministic message when a rule names "the" surface file.
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

// A module declared directly in config (v1), replacing v0's index.ts-
// presence discovery - measured wrong (NestJS's and Drizzle's own barrel
// index.ts files are not operated as enforced boundaries; real code in
// both bypasses them routinely). `surface` is a glob resolved relative to
// `glob`'s own literal base directory (moduleGlobBaseDir below), not the
// project root - matching v0's own convention that `surface` names a file
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
  // The configured public-surface file name (e.g. "index.ts"), carried on
  // the graph so a rule can name it in a message without needing the whole
  // Config passed in just for this one string.
  surface: string;
  // The modules root directory (e.g. "<projectRoot>/src") - rule 6 (type
  // leak) needs it as the boundary a declaration must fall inside to count
  // as internal (a dependency's own types, under node_modules, are not this
  // project's boundary to keep).
  rootDir: string;
  // The program and checker built over every module file - shared here so
  // a rule needing type information (rule 6) does not build its own
  // second program over the same files.
  program: ts.Program;
  checker: ts.TypeChecker;
};

export type BuildOptions = {
  // simulate must adjust the disk file list before buildDeclaredModules
  // derives module metadata. All consumers then use metadata consistent
  // with that list, without a second, manually constructed prepared object.
  fileListOverride?: (realFiles: string[]) => string[];
  projectRoot: string;
  // v0 discovery path - e.g. "src/*" (only single-level globs). Ignored
  // when `declaredModules` is given.
  modulesGlob?: string;
  surface?: string; // the public-surface file name, default "index.ts" - v0 discovery only
  // v1 declaration path - takes priority over `modulesGlob` when present.
  declaredModules?: readonly DeclaredModule[];
  // Glob patterns excluded from the declared-mode file scan entirely -
  // config.exclude (v1 only; v0 discovery has no equivalent, since its
  // scope is already narrowed to one modules root). A file matching any
  // one pattern is invisible to every rule, not just uncounted: it is not
  // a module member, not a source of edges, not a target either.
  exclude?: readonly string[];
};

export const DEFAULT_SURFACE = "index.ts";

// v0's `modules` glob is always one directory level ("src/*"): a fixed
// prefix directory ("src") whose immediate children are modules. Anything
// deeper, or a non-"*" glob, is out of scope for v0 (spec's flat preset).
function parseModulesGlob(modulesGlob: string): { root: string } {
  const parts = modulesGlob.split("/");
  if (parts.length !== 2 || parts[1] !== "*") {
    throw new Error(
      `unsupported modules glob '${modulesGlob}': v0 supports only a single-level glob like 'src/*'`,
    );
  }
  return { root: parts[0]! };
}

function discoverModules(projectRoot: string, glob: string, surface: string): Map<string, Module> {
  const { root } = parseModulesGlob(glob);
  const rootDir = join(projectRoot, root);
  // init is the one verb that runs before anything else exists in a
  // project, so a missing modules root is the likely first-run path, not
  // an edge case. A raw ENOENT from readdirSync doesn't name the glob or
  // what was expected there.
  if (!ts.sys.directoryExists(rootDir)) {
    throw new Error(`modules glob '${glob}' names '${rootDir}', which does not exist`);
  }
  const modules = new Map<string, Module>();
  // ts.sys has no direct "list immediate subdirectories" call; use node:fs.
  for (const name of readdirSync(rootDir).sort()) {
    const dir = join(rootDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const surfacePath = join(dir, surface);
    modules.set(name, {
      name,
      dir,
      files: [],
      surfaceFiles: ts.sys.fileExists(surfacePath) ? [surfacePath] : [],
      surfaceName: surface,
      friends: [], // v0 discovery has no declaredModules entry to carry a friends list
    });
  }
  return modules;
}

function moduleForFile(
  filePath: string,
  projectRoot: string,
  glob: string,
): string | undefined {
  const { root } = parseModulesGlob(glob);
  const rel = relative(join(projectRoot, root), filePath);
  if (rel.startsWith("..")) return undefined; // not under the modules root at all
  const [first, ...rest] = rel.split(sep);
  if (first === undefined || rest.length === 0) return undefined; // a loose file directly under the modules root
  return first;
}

// The literal directory prefix a glob names before its first wildcard,
// trailing slash stripped - "packages/x/**" -> "packages/x". `surface` is
// resolved relative to this, the same way v0's `surface` is relative to a
// discovered module's own directory.
function moduleGlobBaseDir(glob: string): string {
  const firstWildcard = glob.search(/\*/);
  const prefix = firstWildcard === -1 ? glob : glob.slice(0, firstWildcard);
  return prefix.replace(/\/+$/, "");
}

export function toProjectRelativePosix(filePath: string, projectRoot: string): string {
  return relative(projectRoot, filePath).split(sep).join("/");
}

// Recursively lists every .ts file under `projectRoot`, excluding
// node_modules, dist, and every config.exclude glob - the candidate set
// declared-module membership and surface matching both filter from.
// Declared modules can live anywhere under the project, not one fixed
// single-level root the way v0's discovery does, so there is no narrower
// directory to start from.
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
export function surfaceGlobsFor(dm: DeclaredModule, projectRoot: string, globalDefaultSurface: string): string[] {
  const moduleDir = join(projectRoot, moduleGlobBaseDir(dm.glob));
  const surface = effectiveSurface(dm, moduleDir, globalDefaultSurface);
  const entries = Array.isArray(surface) ? surface : [surface as string];
  return entries.map((s) => `${moduleGlobBaseDir(dm.glob)}/${s}`.replace(/\/{2,}/g, "/"));
}

function surfaceGlobsAllowingDts(
  declaredModules: readonly DeclaredModule[],
  projectRoot: string,
  globalDefaultSurface: string,
): string[] {
  return declaredModules
    .flatMap((dm) => surfaceGlobsFor(dm, projectRoot, globalDefaultSurface))
    .filter((g) => g.endsWith(".d.ts"));
}

// A build-output path's own extension, swapped for the real source
// extension every one of these ships from - never guessed beyond this
// fixed, small set (a project using some other build layout entirely
// simply isn't derivable, and falls back to the tool's own default
// instead of a wrong guess).
const BUILT_TO_SOURCE_EXTENSION: readonly [string, string][] = [
  [".d.mts", ".ts"],
  [".d.cts", ".ts"],
  [".d.ts", ".ts"],
  [".mjs", ".ts"],
  [".cjs", ".ts"],
  [".mts", ".ts"],
  [".cts", ".ts"],
  [".js", ".ts"],
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
    // Declaration outputs must pass through the built-to-source conversion.
    const isDeclaration = /\.d\.(?:ts|mts|cts)$/.test(stripped);
    const asSource = !isDeclaration && (stripped.endsWith(".ts") || stripped.endsWith(".tsx")) ? stripped : undefined;
    const guesses =
      asSource !== undefined
        ? [asSource]
        : BUILT_TO_SOURCE_EXTENSION.filter(([ext]) => stripped.endsWith(ext)).map(([ext, replacement]) =>
            stripped.replace(/^dist\//, "").slice(0, -ext.length) + replacement,
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
function effectiveSurface(dm: DeclaredModule, moduleDir: string, globalDefaultSurface: string): string | readonly string[] {
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

function listAllSourceFiles(
  projectRoot: string,
  excludeGlobs: readonly string[],
  declaredModules: readonly DeclaredModule[] = [],
  globalDefaultSurface: string = DEFAULT_SURFACE,
): string[] {
  return ts.sys
    .readDirectory(projectRoot, [".ts"], ["**/node_modules/**", "**/dist/**"])
    .filter((file) => isEligibleSourceFile(file, projectRoot, excludeGlobs, declaredModules, globalDefaultSurface));
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
  globalDefaultSurface: string,
): boolean {
  const rel = toProjectRelativePosix(file, projectRoot);
  if (!file.endsWith(".ts") || rel.split("/").some((part) => part === "node_modules" || part === "dist")) return false;
  if (excludeGlobs.some((glob) => compileGlob(glob).test(rel))) return false;
  return !file.endsWith(".d.ts") || surfaceGlobsAllowingDts(declaredModules, projectRoot, globalDefaultSurface)
    .some((glob) => compileGlob(glob).test(rel));
}

function buildDeclaredModules(
  projectRoot: string,
  declaredModules: readonly DeclaredModule[],
  allFiles: readonly string[],
  globalDefaultSurface: string = DEFAULT_SURFACE,
): Map<string, Module> {
  const membership = declaredModules.map((dm) => ({ glob: dm.glob, value: dm.name }));
  const modules = new Map<string, Module>(
    declaredModules.map((dm) => [
      dm.name,
      {
        name: dm.name,
        dir: join(projectRoot, moduleGlobBaseDir(dm.glob)),
        files: [],
        surfaceFiles: [],
        surfaceName: effectiveSurface(dm, join(projectRoot, moduleGlobBaseDir(dm.glob)), globalDefaultSurface),
        friends: (dm.friends ?? []).map((f) => ({
          fileGlob: `${moduleGlobBaseDir(dm.glob)}/${f.file}`.replace(/\/{2,}/g, "/"),
          from: f.from,
          because: f.because,
        })),
      },
    ]),
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
    // loop, the same way v0 discovery populates it - not duplicated here.
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
  const cache = new Map<string, ts.CompilerOptions>();
  if (rootConfigPath !== undefined) cache.set(rootConfigPath, rootOptions);
  return (filePath: string): ts.CompilerOptions => {
    const configPath = ts.findConfigFile(dirname(filePath), ts.sys.fileExists.bind(ts.sys));
    if (configPath === undefined) return rootOptions;
    const cached = cache.get(configPath);
    if (cached !== undefined) return cached;
    const options = readCompilerOptions(configPath);
    cache.set(configPath, options);
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

  let modules: Map<string, Module>;
  let rootDir: string;
  let rootNames: string[];
  let resolveModuleForFile: (filePath: string) => string | undefined;

  if (declaredModules !== undefined) {
    rootDir = projectRoot;
    rootNames = listAllSourceFiles(projectRoot, exclude, declaredModules, surface);
    if (options.fileListOverride) rootNames = options.fileListOverride(rootNames);
    modules = buildDeclaredModules(projectRoot, declaredModules, rootNames, surface);
    resolveModuleForFile = (filePath) => moduleForDeclaredFile(filePath, projectRoot, declaredModules);
  } else {
    const modulesGlob = options.modulesGlob;
    if (modulesGlob === undefined) {
      throw new Error("buildModuleGraph needs either modulesGlob or declaredModules");
    }
    modules = discoverModules(projectRoot, modulesGlob, surface);
    const { root } = parseModulesGlob(modulesGlob);
    rootDir = join(projectRoot, root);
    rootNames = ts.sys.readDirectory(rootDir, [".ts"]).filter((f) => !f.endsWith(".d.ts"));
    resolveModuleForFile = (filePath) => moduleForFile(filePath, projectRoot, modulesGlob);
  }

  const nonTsSourceFileCount = countNonTsSourceFiles(rootDir, exclude);
  return { projectRoot, surface, rootDir, rootNames, modules, resolveModuleForFile, compilerOptions, compilerOptionsForFile, nonTsSourceFileCount };
}

export function buildModuleGraph(options: BuildOptions): ModuleGraph {
  return buildPreparedGraph(prepareGraph(options));
}

export type GraphBuildOverrides = {
  host?: ts.CompilerHost;
  oldProgram?: ts.Program;
  resolutionCache?: ts.ModuleResolutionCache;
};

export function buildPreparedGraph(prepared: ReturnType<typeof prepareGraph>, overrides: GraphBuildOverrides = {}): ModuleGraph {
  const { projectRoot, surface, rootDir, rootNames, modules, resolveModuleForFile, compilerOptions, compilerOptionsForFile } = prepared;
  const program = ts.createProgram({ rootNames, options: compilerOptions, host: overrides.host, oldProgram: overrides.oldProgram });
  const host = overrides.host ?? ts.createCompilerHost(compilerOptions);

  const outsideFiles: string[] = [];
  const edges: Edge[] = [];
  let unsupportedSyntaxCount = 0;
  let unresolvedSpecifierCount = 0;
  const unresolvedSpecifiers: string[] = [];

  for (const sf of program.getSourceFiles()) {
    if (!rootNames.includes(sf.fileName)) continue; // lib.d.ts, node_modules, etc.
    const fromModule = resolveModuleForFile(sf.fileName);
    if (fromModule === undefined) {
      outsideFiles.push(sf.fileName);
      continue;
    }
    modules.get(fromModule)?.files.push(sf.fileName);

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
        // `import x = require("./y")`: out of scope for v0 (spec targets
        // ESM-only projects; the 15-repo survey found none using this).
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
        const builtin = builtinModuleName(specifier.text);

        if (builtin !== undefined) {
          // No real resolvedFile exists for a builtin - the specifier
          // itself (normalized to the bare, "node:"-stripped name) stands
          // in for one, matching every other external edge's convention of
          // a stable, human-readable identifier rather than a filesystem
          // path that doesn't exist.
          edges.push({
            fromFile: sf.fileName,
            fromModule,
            fromPosition: { line: line + 1, column: character + 1 },
            specifier: specifier.text,
            isTypeOnly,
            isDynamic,
            resolvedFile: `node:${builtin}`,
            toModule: undefined,
            externalPackage: builtin,
          });
        } else {
          // Resolved regardless of a leading "." - a bare specifier
          // (`@internal/a`, `lodash`) is resolved the same way a relative
          // one is; TS's own resolver already follows a workspace
          // package's package.json `exports` under nodenext, so the only
          // thing gating that path before was this project's own code,
          // not TypeScript.
          const resolved = ts.resolveModuleName(specifier.text, sf.fileName, compilerOptionsForFile(sf.fileName), host, overrides.resolutionCache);
          const resolvedModule = resolved.resolvedModule;
          if (resolvedModule === undefined) {
            unresolvedSpecifierCount++;
            unresolvedSpecifiers.push(specifier.text);
          } else {
            const resolvedFile = resolvedModule.resolvedFileName;
            const toModule = resolveModuleForFile(resolvedFile);
            const externalPackage =
              resolvedModule.isExternalLibraryImport && !isWorkspaceSiblingResolution(resolvedFile, projectRoot)
                ? (resolvedModule.packageId?.name ?? specifier.text.replace(/^node:/, ""))
                : undefined;
            edges.push({
              fromFile: sf.fileName,
              fromModule,
              fromPosition: { line: line + 1, column: character + 1 },
              specifier: specifier.text,
              isTypeOnly,
              isDynamic,
              resolvedFile,
              toModule,
              externalPackage,
            });
          }
        }
      }

      ts.forEachChild(node, walk);
    });
  }

  const crossModuleEdges = edges.filter(
    (e) => e.toModule !== undefined && e.toModule !== e.fromModule,
  );

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
    program,
    get checker() {
      return program.getTypeChecker();
    },
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const ARCHSTRICT_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function cacheMetadata(projectRoot: string, options: BuildOptions): Record<string, number | null> {
  const packages = [join(projectRoot, "package.json"), ...(options.declaredModules ?? [])
    .map((dm) => join(projectRoot, moduleGlobBaseDir(dm.glob), "package.json"))];
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]
    .map((name) => join(projectRoot, name)).find((path) => existsSync(path));
  if (lock !== undefined) packages.push(lock);
  return Object.fromEntries([...new Set(packages)].sort().map((path) => [path, existsSync(path) ? statSync(path).mtimeMs : null]));
}

export function graphBuildFingerprint(options: BuildOptions, prepared: ReturnType<typeof prepareGraph>) {
  const { projectRoot, rootNames, compilerOptions, compilerOptionsForFile } = prepared;
  const tsconfigHash = hash({ root: compilerOptions, files: rootNames.map((file) => [file, compilerOptionsForFile(file)]) });
  const buildOptionsHash = hash({ declaredModules: options.declaredModules, modulesGlob: options.modulesGlob,
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
    };
  }
  const graph = buildPreparedGraph(prepared);
  const files: EdgeCache["files"] = Object.fromEntries(rootNames.map((file) => [file, { mtimeMs: mtimes[file]!, edges: [] }]));
  for (const edge of graph.edges) files[edge.fromFile]!.edges.push(edge);
  // Do not label an analysis with mtimes from a concurrent edit.
  if (rootNames.every((file) => existsSync(file) && statSync(file).mtimeMs === mtimes[file])) {
    writeEdgeCache(path, { schema: 1, tsconfigHash, archstrictVersion: ARCHSTRICT_VERSION, buildOptionsHash, metadata, files,
      sourceOrder: graph.program.getSourceFiles().map((sf) => sf.fileName).filter((file) => Object.hasOwn(files, file)),
      unsupportedSyntaxCount: graph.unsupportedSyntaxCount, unresolvedSpecifiers: graph.unresolvedSpecifiers });
  }
  return graph;
}
