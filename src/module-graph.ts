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

export type Position = { line: number; column: number };

export type Edge = {
  fromFile: string;
  fromModule: string;
  fromPosition: Position;
  specifier: string;
  isTypeOnly: boolean;
  resolvedFile: string;
  toModule: string | undefined; // undefined when resolvedFile is outside every module (e.g. a package, or an outside-glob file)
};

export type Module = {
  name: string;
  dir: string;
  files: string[];
  // The module's public surface: the one file other modules may import
  // from. The tool does not fix the file name itself — a project's own
  // config names it (`surface`, default "index.ts"); this is that file's
  // path if it exists in this module, undefined otherwise.
  surfacePath: string | undefined;
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
};

export type BuildOptions = {
  projectRoot: string;
  modulesGlob: string; // e.g. "src/*" — only single-level globs are supported in v0
  surface?: string; // the public-surface file name, default "index.ts"
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
      surfacePath: ts.sys.fileExists(surfacePath) ? surfacePath : undefined,
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

function loadCompilerOptions(projectRoot: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists.bind(ts.sys));
  if (configPath === undefined) {
    return { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext };
  }
  const { config } = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"));
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath)).options;
}

export function buildModuleGraph(options: BuildOptions): ModuleGraph {
  const { projectRoot, modulesGlob, surface = DEFAULT_SURFACE } = options;
  const modules = discoverModules(projectRoot, modulesGlob, surface);
  const compilerOptions = loadCompilerOptions(projectRoot);
  const { root } = parseModulesGlob(modulesGlob);
  const rootDir = join(projectRoot, root);

  const rootNames = ts.sys
    .readDirectory(rootDir, [".ts"])
    .filter((f) => !f.endsWith(".d.ts"));
  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const host = ts.createCompilerHost(compilerOptions);

  const outsideFiles: string[] = [];
  const edges: Edge[] = [];
  let unsupportedSyntaxCount = 0;
  let unresolvedSpecifierCount = 0;

  for (const sf of program.getSourceFiles()) {
    if (!rootNames.includes(sf.fileName)) continue; // lib.d.ts, node_modules, etc.
    const fromModule = moduleForFile(sf.fileName, projectRoot, modulesGlob);
    if (fromModule === undefined) {
      outsideFiles.push(sf.fileName);
      continue;
    }
    modules.get(fromModule)?.files.push(sf.fileName);

    ts.forEachChild(sf, function walk(node) {
      let specifier: ts.Expression | undefined;
      let isTypeOnly = false;

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
        if (specifier.text.startsWith(".")) {
          const resolved = ts.resolveModuleName(
            specifier.text,
            sf.fileName,
            compilerOptions,
            host,
          );
          const resolvedFile = resolved.resolvedModule?.resolvedFileName;
          if (resolvedFile === undefined) {
            unresolvedSpecifierCount++;
          } else {
            const start = specifier.getStart(sf);
            const { line, character } = sf.getLineAndCharacterOfPosition(start);
            const toModule = moduleForFile(resolvedFile, projectRoot, modulesGlob);
            edges.push({
              fromFile: sf.fileName,
              fromModule,
              fromPosition: { line: line + 1, column: character + 1 },
              specifier: specifier.text,
              isTypeOnly,
              resolvedFile,
              toModule,
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
  };
}
