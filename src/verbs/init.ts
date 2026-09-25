// Responsibility: the `init` verb. On a fresh project (no
// archstrict.config.ts yet), walks the project's own real files with
// check's own eligibility rule (module-graph.ts's listAnalyzedFiles) and
// declares one module per top-level directory that holds an analyzed .ts
// file, and one single-file module per loose top-level .ts file - so every
// file the first `check` analyzes already belongs to exactly one module,
// by construction. On a re-run, init never touches an existing config: it
// only re-reads it and regenerates archstrict.types.ts (the ModuleName
// union) from its own declaredModules names.
// Boundary: file I/O, argument parsing, and text generation only. Grouping
// files into modules and naming them is module-candidates.ts's job (a pure
// function of the file list); init only decides WHICH files and anchors
// that function sees, and writes what it returns.
//
// Singletons over one catch-all module or a menu of shapes: a project
// whose first init already covers every analyzed file needs no
// uncovered-module violation todo could never freeze away (an unfreezable
// violation, since a file matching no module has no module directory to
// freeze it into) - the trap an inventory-only design (declare directories,
// leave loose files uncovered) falls into on a real, unconventional
// codebase. A single catch-all module for every loose file was rejected
// too: it produces a degenerate public surface (every loose file's own
// exports at once) and a glob whose own base directory is the project
// root, which - with a real node_modules present - puts node_modules
// itself inside rule 6's own type-leak boundary.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SURFACE, listAnalyzedFiles, toProjectRelativePosix, type DeclaredModule } from "../module-graph.js";
import { groupAnalyzedFiles, nameCandidates, declaredModuleEntryText, type NamedCandidateGroup } from "../module-candidates.js";
import { SCHEMA_VERSION } from "../config.js";
import { ReportError } from "../report-error.js";
import { loadConfig } from "./check.js";

export type InitResult = {
  configPath: string;
  generatedPath: string;
  configWritten: boolean; // false when archstrict.config.ts already existed and was left alone
  moduleNames: string[];
  // Every stdout line this run produced, in order, except the final
  // "do:" line - every successful run (fresh or re-run) ends with the
  // same "do: archstrict check" under this change's own scope (a re-run's
  // own uncovered-file listing, which would sometimes vary that line, is
  // separate, later work), so the CLI appends it once itself instead of
  // every caller repeating it.
  messageLines: string[];
};

const DO_INIT = "archstrict init";

function fail(message: string, doText: string): never {
  throw new ReportError(message, doText);
}

// A name must be near-universally non-source across ordinary TypeScript
// projects, not merely something one specific project happened to use
// (docs/, migrations/, and this project's own plugin/skills directories
// are real source in some real projects, so they stay out) - init only
// ever excludes a name from this list when it finds a real top-level
// directory of that name on disk, never blindly. dist/ is deliberately
// absent: listAnalyzedFiles already drops every path with a dist segment,
// so a "dist/**" exclude entry would change nothing real, only add a line
// nobody ever needs to remove.
const NOISE_DIR_CANDIDATES = ["test", "tests", "example", "examples", "spike", "build", "coverage", "fixtures", "e2e", "tmp"];

const OWN_FILES = ["archstrict.config.ts", "archstrict.types.ts"];

// tsc's own default `include` already skips every hidden path; ts.sys's
// own readDirectory does not, which floods a first check with files from
// tool-state directories (.git, an editor's own cache) that were never
// really project source. These two patterns are the same on every
// machine (unlike naming a specific hidden directory found on disk, which
// would put a local, one-machine name into a committed config) - one for
// a hidden directory at the project root, one for a hidden directory at
// any deeper level.
const HIDDEN_EXCLUDE = [".*/**", "**/.*/**"];

function isRealDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function findNoiseDirs(projectRoot: string, keptOpen: string): string[] {
  // A container named on the command line is real source the caller
  // asked to open, never treated as noise - `archstrict init test` opens
  // test/ and does not also exclude it.
  // Matched against the exact entries readdirSync returns, not
  // existsSync(join(projectRoot, name)) - existsSync resolves through a
  // case-insensitive filesystem, so a real `Test/` would otherwise match
  // the candidate name "test" and init would exclude a directory that
  // isn't there under that spelling (and declare it a module too, since
  // the walk itself finds "Test/" by its real name).
  const onDisk = new Set(readdirSync(projectRoot));
  return NOISE_DIR_CANDIDATES.filter(
    (name) => name !== keptOpen && onDisk.has(name) && statSync(join(projectRoot, name)).isDirectory(),
  );
}

// The argument table's own syntax rules - stripping a trailing "/*" or
// "/", rejecting a leftover glob character, a leftover "/", a hidden name,
// or a name init never analyzes anyway. Applied on every run, fresh or
// re-run: a re-run ignores a valid directory argument (see the re-run
// section below), but a syntactically invalid one is still an error, not
// silently ignored. Returns "" for "no container" (the project root
// alone), and undefined when no argument was given at all.
function normalizeDirArg(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "." || raw === "./" || raw === "*") return "";
  const stripped = raw.replace(/\/\*$/, "").replace(/\/+$/, "");
  if (/[*?[\]{}]/.test(stripped)) fail(`init takes a directory name, not the glob '${raw}'`, DO_INIT);
  if (stripped.includes("/")) fail(`init takes one top-level directory name, not '${raw}'`, DO_INIT);
  if (stripped.startsWith(".")) {
    fail(
      `init does not open the hidden directory '${stripped}': the exclude that init writes skips hidden directories`,
      DO_INIT,
    );
  }
  if (stripped === "node_modules" || stripped === "dist") {
    fail(`init does not open '${stripped}': check never analyzes it`, DO_INIT);
  }
  return stripped;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function countLabel(groups: readonly NamedCandidateGroup[]): string {
  const dirs = groups.filter((g) => g.kind === "dir").length;
  const files = groups.filter((g) => g.kind === "file").length;
  return `${plural(dirs, "directory", "directories")}, ${plural(files, "file", "files")}`;
}

const q = JSON.stringify;

function configText(
  opened: string,
  containerGroups: readonly NamedCandidateGroup[],
  topGroups: readonly NamedCandidateGroup[],
  exclude: readonly string[],
  noiseDirs: readonly string[],
): string {
  const lines: string[] = [];
  if (containerGroups.length > 0) {
    lines.push(`    // Each directory and .ts file directly in ${opened}/.`);
    lines.push(...containerGroups.map((g) => `    ${declaredModuleEntryText(g.entry)},`));
  }
  if (topGroups.length > 0) {
    lines.push(
      opened !== ""
        ? `    // Each other top-level directory that holds .ts, and each top-level .ts file.`
        : `    // Each top-level directory that holds .ts, and each top-level .ts file.`,
    );
    lines.push(...topGroups.map((g) => `    ${declaredModuleEntryText(g.entry)},`));
  }

  const noiseComment =
    noiseDirs.length > 0
      ? `\n  // - common noise directories that init found on disk (${noiseDirs.join(", ")}).\n  //   Remove one of these entries if that directory holds module content.`
      : "";

  return `import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its index.ts (named by \`surface\` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: ${SCHEMA_VERSION},
  surface: ${q(DEFAULT_SURFACE)},
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;${noiseComment}
  exclude: [
${exclude.map((e) => `    ${q(e)},`).join("\n")}
  ],
  // init declared one module per directory that holds .ts and one per .ts
  // file, so every file that check analyzes belongs to exactly one module.
  // Merge, rename, or remove entries freely: init never rewrites this file.
  // After an edit, run archstrict init to regenerate archstrict.types.ts.
  declaredModules: [
${lines.join("\n")}
  ],
  because: "archstrict init: one module per directory that holds .ts and per .ts file, so the first check covers every file it analyzes",
} satisfies Config;
`;
}

function generatedFileContents(moduleNames: string[]): string {
  const union = moduleNames.length > 0 ? moduleNames.map((n) => JSON.stringify(n)).join(" | ") : "never";
  return `// Generated by archstrict init from archstrict.config.ts's own
// declaredModules. Do not edit this file directly: after adding, removing,
// or renaming a declaredModules entry, run archstrict init again to
// regenerate this union to match.
export type ModuleName = ${union};

// configPath is added by the loader, not written here - a config file
// cannot know its own path.
export type Config = {
  // The schema this config was written for. ${SCHEMA_VERSION} is the only
  // value archstrict reads. Omit it and the loader treats the file as
  // schema ${SCHEMA_VERSION}.
  schemaVersion?: ${SCHEMA_VERSION};
  surface?: string;
  deprecated?: readonly {
    from: ModuleName;
    to: ModuleName;
    count: number;
    because: string;
  }[];
  // Module names whose todo file may only shrink, never gain a new entry.
  // check reports any existing entry in one of these modules' todo as a
  // violation in its own right.
  strict?: readonly ModuleName[];
  // A specific known cycle (naming any two modules in it, in either
  // order) exempted from rule 2 - an entry naming a pair no longer in any
  // real cycle is itself flagged (stale-cycle-exception).
  ignoredCycles?: readonly (readonly [string, string])[];
  // An analysis boundary narrower than the whole project - not yet read
  // by any rule or verb (declared here for forward compatibility; wiring
  // it in is separate, later work).
  scope?: string;
  // Glob patterns kept out of analysis entirely - not a member of any
  // module, not a source of edges, not a target either. init writes one
  // default: this project's own root-level files (archstrict.config.ts,
  // archstrict.types.ts) are never module content.
  exclude?: readonly string[];
  // glob -> tags, most-specific-glob-wins. Independent of declaredModules
  // below - tags classify any file; declaredModules says which files form
  // an enforced module boundary.
  classify?: readonly { glob: string; tags: readonly string[] }[];
  // Ambient tagging by directory-name segment: the nearest path segment
  // matching one of \`names\`, walking from the file outward, becomes
  // \`\${tagNamespace}:\${name}\`. Independent of \`classify\` above - a file
  // can carry tags from both mechanisms at once.
  classifyByDirectoryName?: {
    tagNamespace: string;
    names: readonly string[];
  };
  // Declared modules - the source of truth for module boundaries.
  // \`surface\` may itself be a glob (a module's public surface can be
  // more than one file).
  declaredModules: readonly {
    name: ModuleName;
    glob: string;
    // A single glob, or several - a real package can publish more than
    // one real, differently-shaped public entry point at once. Optional:
    // when absent, a real package.json's own exports map at this
    // module's own root is derived back to source instead, falling back
    // to this project's own top-level surface default otherwise.
    surface?: string | readonly string[];
    // Rule 1's own "friend" exception: \`file\` (relative to this module,
    // may itself be a glob) is public to exactly the importers \`from\`
    // (a project-relative glob) matches, private to everyone else -
    // unlike \`surface\`, which is public to every importer equally.
    friends?: readonly { file: string; from: string; because: string }[];
  }[];
  // A directory that must hold no code at all (archspec's own
  // "empty component" idea) - a violation is any file matching the glob.
  mustBeEmpty?: readonly { glob: string; because: string }[];
  // The constraint engine: allowDeny/order/point rules over classify
  // tags, generalizing the fixed module vocabulary above. \`allowDeny\`'s
  // own \`exceptions\`: a from/to glob or tag-predicate pair that overrides
  // that rule either way for one specific edge - \`point\` has no
  // exceptions of its own, its from/to predicates already being as
  // explicit as a rule gets.
  edges?: {
    allowDeny?: readonly {
      source: string;
      targetNamespace: string;
      allow?: readonly string[];
      deny?: readonly string[];
      exceptions?: readonly { from: string; to: string; because: string }[];
      edgeType?: "value" | "type" | "both";
      importForm?: "static" | "dynamic" | "both";
      because: string;
    }[];
    order?: readonly {
      tagNamespace: string;
      within?: string;
      sequence: Record<string, readonly string[]>;
      direction: "downward-only";
      edgeType?: "value" | "type" | "both";
      importForm?: "static" | "dynamic" | "both";
      because: string;
    }[];
    point?: readonly {
      from: string | { tags: readonly string[]; exclude?: { tags: readonly string[] } };
      to: string | { tags: readonly string[] };
      edgeType?: "value" | "type" | "both";
      importForm?: "static" | "dynamic" | "both";
      because: string;
    }[];
  };
  because: string;
};
`;
}

// The fresh-run walk: find every analyzed file under the seeded exclude,
// group it under the opened container (if any) plus the project root, and
// name every group - module-candidates.ts owns the grouping/naming rule
// itself, this only decides which files and anchors it sees.
function freshRun(
  projectRoot: string,
  dir: string | undefined,
): {
  opened: string;
  rootLabel: string | undefined;
  noiseDirs: string[];
  exclude: string[];
  containerGroups: NamedCandidateGroup[];
  topGroups: NamedCandidateGroup[];
} {
  const explicit = dir !== undefined;
  const want = dir ?? "src";
  const noiseDirs = findNoiseDirs(projectRoot, want);
  const exclude = [...OWN_FILES, ...HIDDEN_EXCLUDE, ...noiseDirs.map((n) => `${n}/**`)];
  // Project-relative, POSIX-separated: every anchor, glob, and stdout path
  // below is project-relative too, and listAnalyzedFiles itself returns
  // absolute, platform-separated paths (the same shape a real TypeScript
  // program's own file names take).
  const files = listAnalyzedFiles(projectRoot, exclude).map((f) => toProjectRelativePosix(f, projectRoot));

  let opened = "";
  let rootLabel: string | undefined;
  if (want !== "") {
    const holds = files.some((f) => f.startsWith(`${want}/`));
    if (holds) {
      opened = want;
    } else if (explicit) {
      fail(`'${want}' is not a top-level directory that holds a .ts file check analyzes`, DO_INIT);
    } else {
      rootLabel = isRealDirectory(join(projectRoot, want))
        ? `top level; ${want}/ holds no .ts file`
        : `top level; there is no ${want}/ directory`;
    }
  } else {
    rootLabel = "top level";
  }

  const anchors = opened === "" ? [""] : ["", opened];
  const groups = nameCandidates(groupAnalyzedFiles(files, anchors), new Set());
  if (groups.length === 0) {
    // Every analyzed .ts file the plain walk (no noise exclude applied)
    // finds is inside a noise directory, or there is none at all. In the
    // first case, naming that directory ("archstrict init test") is a
    // real fix - opening it declares its files as modules instead of
    // excluding them. In the second, there is nothing on disk to open.
    const beforeNoiseExclude = listAnalyzedFiles(projectRoot, [...OWN_FILES, ...HIDDEN_EXCLUDE]).map((f) =>
      toProjectRelativePosix(f, projectRoot),
    );
    const openable = noiseDirs.find((n) => beforeNoiseExclude.some((f) => f.startsWith(`${n}/`)));
    fail(
      `found no .ts file to declare as a module in ${projectRoot} (init skips node_modules/, dist/, hidden directories, and noise directories)`,
      openable !== undefined
        ? `archstrict init ${openable}`
        : "add a .ts source file outside those directories, then run archstrict init",
    );
  }

  return {
    opened,
    rootLabel,
    noiseDirs,
    exclude,
    containerGroups: groups.filter((g) => g.anchor !== ""),
    topGroups: groups.filter((g) => g.anchor === ""),
  };
}

// The root-level hidden directories that hold at least one analyzed file -
// used only for the stdout line naming them, never for anything the
// generated config depends on (the committed hidden-directory exclude
// patterns are fixed and machine-independent; see HIDDEN_EXCLUDE's own
// comment). A second scan, leaving the two hidden patterns out of the
// exclude list, is simpler than teaching the first scan to also report
// what it's about to exclude.
function findHiddenTopDirs(projectRoot: string, noiseDirs: readonly string[]): string[] {
  const files = listAnalyzedFiles(projectRoot, [...OWN_FILES, ...noiseDirs.map((n) => `${n}/**`)]).map((f) =>
    toProjectRelativePosix(f, projectRoot),
  );
  const names = new Set<string>();
  for (const f of files) {
    const [first] = f.split("/");
    if (first !== undefined && first.startsWith(".") && f.includes("/")) names.add(first);
  }
  return [...names].sort();
}

export async function init(projectRoot: string, rawDir?: string): Promise<InitResult> {
  const dir = normalizeDirArg(rawDir);
  const configPath = join(projectRoot, "archstrict.config.ts");
  const generatedPath = join(projectRoot, "archstrict.types.ts");
  const configWritten = !existsSync(configPath);
  const messageLines: string[] = [];

  if (!configWritten) {
    // A re-run never touches the config, and never runs the fresh-run
    // walk at all - only its own syntax is validated above; a re-run has
    // nowhere to open a container into anyway, since the config on disk
    // already says what's declared.
    messageLines.push(`${configPath} already exists, left untouched`);
    if (dir !== undefined) {
      messageLines.push(`the directory argument applies only when init writes a new archstrict.config.ts`);
    }
    const config = await loadConfig(configPath, undefined, DO_INIT);
    // `?? []` is for the type checker, not runtime defense: loadConfig
    // itself now rejects any loaded config whose declaredModules is
    // missing, non-array, or holds a malformed entry, so this line never
    // actually sees a bad shape. Config's own `declaredModules` field
    // stays typed optional regardless (other Config values exist that
    // never went through loadConfig), so the fallback keeps typechecking.
    const moduleNames = [...new Set((config.declaredModules ?? []).map((m: DeclaredModule) => m.name))].sort();
    writeFileSync(generatedPath, generatedFileContents(moduleNames));
    messageLines.push(
      `wrote ${generatedPath}: ${plural(moduleNames.length, "module name", "module names")}, read from archstrict.config.ts`,
    );
    return { configPath, generatedPath, configWritten, moduleNames, messageLines };
  }

  const { opened, rootLabel, noiseDirs, exclude, containerGroups, topGroups } = freshRun(projectRoot, dir);
  writeFileSync(configPath, configText(opened, containerGroups, topGroups, exclude, noiseDirs));
  const config = await loadConfig(configPath, undefined, DO_INIT);
  const moduleNames = [...new Set((config.declaredModules ?? []).map((m: DeclaredModule) => m.name))].sort();
  writeFileSync(generatedPath, generatedFileContents(moduleNames));

  messageLines.push(`wrote ${configPath}`, `wrote ${generatedPath}`);
  const allGroups = [...containerGroups, ...topGroups];
  messageLines.push(`declared ${plural(allGroups.length, "module", "modules")}, one per directory that holds .ts and one per .ts file:`);
  if (opened !== "") messageLines.push(`  ${opened}/: ${countLabel(containerGroups)}`);
  if (topGroups.length > 0) {
    const label = opened !== "" ? `outside ${opened}/` : rootLabel!;
    const names = topGroups.map((g) => g.entry.name).join(", ");
    messageLines.push(`  ./ (${label}): ${countLabel(topGroups)}: ${names}`);
  }
  const hiddenDirs = findHiddenTopDirs(projectRoot, noiseDirs);
  if (hiddenDirs.length > 0) {
    messageLines.push(
      `excluded ${plural(hiddenDirs.length, "hidden directory", "hidden directories")} that ${hiddenDirs.length === 1 ? "holds" : "hold"} .ts: ${hiddenDirs.map((n) => `${n}/`).join(", ")}`,
    );
  }
  if (noiseDirs.length > 0) {
    messageLines.push(
      `excluded ${plural(noiseDirs.length, "noise directory", "noise directories")} found on disk: ${noiseDirs.map((n) => `${n}/`).join(", ")}`,
    );
  }
  if (opened !== "" && containerGroups.length > 0 && containerGroups.every((g) => g.kind === "file")) {
    messageLines.push(
      `${opened}/ holds only files, so each file is its own module. To check ${opened}/ as one module instead (then no import between two of its files is checked): delete archstrict.config.ts, then run archstrict init .`,
    );
  }

  return { configPath, generatedPath, configWritten, moduleNames, messageLines };
}
