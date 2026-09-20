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
import { readdirSync, readFileSync, statSync } from "node:fs";
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
  // npm package, resolved through node_modules or a workspace's own
  // package.json - TS flags this `isExternalLibraryImport`), not a file
  // this project's own modules glob covers. A leading "node:" is stripped
  // so `import "fs"` and `import "node:fs"` name the same package. This is
  // the raw fact a later rule synthesizes a `pkg:` tag from - this module
  // does not itself know about tags.
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
  surface: string;
};

export type ModuleGraph = {
  modules: Map<string, Module>;
  edges: Edge[];
  crossModuleEdges: Edge[];
  outsideFiles: string[]; // .ts files under the project root that match no module
  unsupportedSyntaxCount: number; // require(), import x = require(...): out of scope for v0
  unresolvedSpecifierCount: number;
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
function listAllSourceFiles(projectRoot: string, excludeGlobs: readonly string[]): string[] {
  const compiledExcludes = excludeGlobs.map((g) => compileGlob(g));
  return ts.sys
    .readDirectory(projectRoot, [".ts"], ["**/node_modules/**", "**/dist/**"])
    .filter((f) => !f.endsWith(".d.ts"))
    .filter((f) => {
      const rel = toProjectRelativePosix(f, projectRoot);
      return !compiledExcludes.some((glob) => glob.test(rel));
    });
}

function buildDeclaredModules(
  projectRoot: string,
  declaredModules: readonly DeclaredModule[],
  allFiles: readonly string[],
): Map<string, Module> {
  const membership = declaredModules.map((dm) => ({ glob: dm.glob, value: dm.name }));
  const modules = new Map<string, Module>(
    declaredModules.map((dm) => [
      dm.name,
      { name: dm.name, dir: join(projectRoot, moduleGlobBaseDir(dm.glob)), files: [], surfaceFiles: [] },
    ]),
  );

  const surfaceGlobs = new Map(
    declaredModules.map((dm) => [
      dm.name,
      `${moduleGlobBaseDir(dm.glob)}/${dm.surface}`.replace(/\/{2,}/g, "/"),
    ]),
  );

  for (const file of allFiles) {
    const rel = toProjectRelativePosix(file, projectRoot);
    const name = mostSpecificMatch(rel, membership, (a, b) => a === b);
    if (name === undefined) continue;
    // Only surfaceFiles is populated here - `files` (every file, not just
    // the surface) is populated once, in buildModuleGraph's shared walk
    // loop, the same way v0 discovery populates it - not duplicated here.
    const surfaceGlob = surfaceGlobs.get(name)!;
    if (compileGlob(surfaceGlob).test(rel)) {
      modules.get(name)!.surfaceFiles.push(file);
    }
  }
  for (const module of modules.values()) {
    module.surfaceFiles.sort();
  }
  return modules;
}

function moduleForDeclaredFile(
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

function loadCompilerOptions(projectRoot: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists.bind(ts.sys));
  if (configPath === undefined) {
    return { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext };
  }
  const { config } = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath)).options;
}

export function buildModuleGraph(options: BuildOptions): ModuleGraph {
  const { projectRoot, declaredModules, surface = DEFAULT_SURFACE, exclude = [] } = options;
  const compilerOptions = loadCompilerOptions(projectRoot);

  let modules: Map<string, Module>;
  let rootDir: string;
  let rootNames: string[];
  let resolveModuleForFile: (filePath: string) => string | undefined;

  if (declaredModules !== undefined) {
    rootDir = projectRoot;
    rootNames = listAllSourceFiles(projectRoot, exclude);
    modules = buildDeclaredModules(projectRoot, declaredModules, rootNames);
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

  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const host = ts.createCompilerHost(compilerOptions);

  const outsideFiles: string[] = [];
  const edges: Edge[] = [];
  let unsupportedSyntaxCount = 0;
  let unresolvedSpecifierCount = 0;

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
        isTypeOnly = node.importClause?.isTypeOnly ?? false;
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        specifier = node.moduleSpecifier;
        isTypeOnly = node.isTypeOnly;
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
          const resolved = ts.resolveModuleName(specifier.text, sf.fileName, compilerOptions, host);
          const resolvedModule = resolved.resolvedModule;
          if (resolvedModule === undefined) {
            unresolvedSpecifierCount++;
          } else {
            const resolvedFile = resolvedModule.resolvedFileName;
            const toModule = resolveModuleForFile(resolvedFile);
            const externalPackage = resolvedModule.isExternalLibraryImport
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
    unsupportedSyntaxCount,
    unresolvedSpecifierCount,
    surface,
    rootDir,
    program,
    checker: program.getTypeChecker(),
  };
}
