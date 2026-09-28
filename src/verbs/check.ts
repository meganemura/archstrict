// Responsibility: the `check` verb. Loads a real archstrict.config.ts,
// builds the module graph, runs every available rule, and aggregates the
// results into one shape for JSON and text output.
// Boundary: this is where the six rules' differing return shapes get
// normalized to one — `deprecated`'s two arrays (violations/suggestions)
// flatten in here, not in each rule.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { buildModuleGraphForRules, type ModuleGraph, type BuildOptions } from "../module-graph.js";
import { assertEdgesShapeValid, assertGlobsSupported, assertSchemaVersion, describeShape, type Config } from "../config.js";
import { ReportError } from "../report-error.js";
import { checkPublicSurfaceBypass, type Violation as PublicSurfaceViolation } from "../rules/public-surface.js";
import {
  checkCycles,
  checkStaleCycleExceptions,
  type StaleExceptionViolation as StaleCycleExceptionViolation,
  type Violation as CycleViolation,
} from "../rules/cycles.js";
import { checkUncoveredModules, type Violation as UncoveredViolation } from "../rules/uncovered.js";
import { checkEmptyRuleSet, type Violation as EmptyRuleViolation } from "../rules/empty-rule.js";
import {
  checkDeprecatedEdges,
  type Suggestion as DeprecatedSuggestion,
  type Violation as DeprecatedViolation,
} from "../rules/deprecated.js";
import { checkTypeLeaks, type Violation as TypeLeakViolation } from "../rules/type-leak.js";
import { checkMustBeEmpty, type Violation as MustBeEmptyViolation } from "../rules/must-be-empty.js";
import {
  checkAllowDeny,
  checkEdgesCoverage,
  checkOrder,
  checkPoint,
  type ConstraintViolation,
  type EdgeRuleCoverage,
} from "../rules/constraints.js";
import { checkConfigMeaning, type Prover, type Violation as ConfigMeaningViolation } from "../rules/config-meaning.js";
import {
  buildTodoIndex,
  EMPTY_TODO_INDEX,
  findMatchingEntry,
  fingerprintOf,
  readTodoFile,
  type ParsedTodoFile,
  type TodoEntry,
  type TodoIndex,
} from "../todo-store.js";
import { readLegacyTodoState } from "../todo-migration.js";
import {
  createConfigLocator,
  declaredModulePointerForName,
  locateViolation,
  locateViolations,
  type ConfigLocator,
  type ConfigPointers,
} from "../config-pointer.js";

// Not one of the six rules: reported when a todo entry matches no current
// violation (import-linter's own default for the same case is also an
// error, not a silent pass). It has no todoModule of its own - freezing a
// stale-todo finding would be circular.
export type StaleTodoViolation = {
  rule: "stale-todo";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

// Reported when a module configured to stay clean (config's `strict` list)
// has any todo entries at all: staying clean means no debt, not debt
// frozen at whatever existed when the module was added to that list. No
// todoModule - this violation cannot itself be frozen away.
export type CleanModuleHasTodoViolation = {
  rule: "clean-module-has-todo";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

export type RawViolation =
  | PublicSurfaceViolation
  | CycleViolation
  | UncoveredViolation
  | EmptyRuleViolation
  | DeprecatedViolation
  | TypeLeakViolation
  | StaleTodoViolation
  | CleanModuleHasTodoViolation
  | StaleCycleExceptionViolation
  | MustBeEmptyViolation
  | ConstraintViolation
  | ConfigMeaningViolation;

// Set only by applyTodo's own --frozen path (ApplyTodoOptions.includeFrozen):
// a violation this call would otherwise have suppressed as todo-matched,
// kept in `violations` instead and marked so a reader (and the exit code)
// can tell it apart from a live one. Absent (not false) on every other
// violation, so JSON.stringify omits the field and default `check` output
// stays byte-identical to before this existed.
export type AnyViolation = RawViolation & { config: ConfigPointers; frozen?: true };

export function formatConfigPointerLines(config: ConfigPointers): string[] {
  const pointers = Array.isArray(config) ? config : [config];
  return pointers.map((pointer) =>
    `  config: ${pointer.path}:${pointer.line}:${pointer.column} ${pointer.pointer} (${pointer.role})`);
}

export type CheckResult = {
  modules: number;
  modulesWithoutSurface: number; // how many modules have no public surface present — the same fact rule 1's violations imply, restated as one count
  modulesWithoutSurfaceNames: string[]; // names let text distinguish a missing surface from a bypass around an existing surface
  edges: number;
  outsideFiles: number;
  nonTsSourceFiles: number; // visibility count only; these files do not produce violations
  unresolvedSpecifiers: number;
  // The top distinct unresolved-specifier prefixes and their counts, most
  // frequent first - a bare count alone couldn't tell "one specifier, many
  // uses" from "many distinct specifiers," which cost real diagnosis time in
  // a large monorepo tracking down one missing tsconfig paths entry (measured
  // directly, authoring a config against nrwl/nx's own packages/). Capped at
  // the top 10 so this stays readable even when unresolvedSpecifiers itself
  // is in the thousands.
  unresolvedSpecifierBreakdown: { prefix: string; count: number }[];
  unsupportedSyntax: number;
  // How many type-leak violations rule 6 found. A surface-focused call
  // counts only findings at the requested surface because the Program checks one closure.
  // A project-wide count is refused because that run does not compute one.
  // 0 means it ran and found none.
  // null means rule 6 did not run at all this call (a `check <file>`
  // scoped to a file that is not any
  // module's own surface - see check()'s own `skipTypeLeak`): "not
  // evaluated" is a different fact than "evaluated, found none", and the
  // two must never share one number.
  typeLeaks: number | null;
  // The file named in the `check <file>` call that made `typeLeaks` null,
  // for formatText's own message - undefined whenever typeLeaks isn't
  // null (JSON.stringify omits an undefined field, the same convention
  // an Edge's own optional fields already follow).
  typeLeaksSkippedFile?: string;
  // How many violations were suppressed by a frozen todo entry, counting
  // only the rules that actually ran this call - a rule this call skipped
  // (rule 6, on a scoped non-surface-file run) contributes 0 here for its
  // own frozen entries too, since their real status (still a violation,
  // or fixed) is unknown this run, not "suppressed".
  //
  // On a `check <file>` run, this counts only the entries whose own
  // violation is reported at that file - the same restriction
  // `typeLeaks: null` already applies to a skipped rule 6: a scoped run
  // states facts about the scoped file, not about the whole project. A
  // frozen violation elsewhere (a different module's own public-surface
  // bypass, cycle, or type-leak, still real and still suppressed on a
  // full `check`) contributes 0 here on a scoped run - reported as
  // "unknown this run", the same status any other rule's skipped
  // findings already carry, not folded into a project-wide count next to
  // a report about one file.
  todo: number;
  violations: AnyViolation[];
  suggestions: DeprecatedSuggestion[];
  // How many real edges each configured allowDeny/order/point rule
  // actually evaluated - not just whether it violated. A rule with
  // evaluated: 0 is also reported as an empty-rule-set violation (rule 4);
  // this field exists so an agent authoring a NEW edges rule can see the
  // real number directly instead of writing a throwaway script against
  // the graph, the same gap that made a genuinely vacuous rule look
  // identical to a clean pass in real use.
  edgeRuleCoverage: EdgeRuleCoverage[];
  // Set only when rule 6's own closure Program (type-closure.ts) had to
  // fall back to the whole-project Program this call - undefined on every
  // ordinary run (JSON.stringify omits it then, the same convention
  // `typeLeaksSkippedFile` follows), never silently: rule 6's own findings
  // are still real either way, but a fallback run costs far more memory
  // than the closure this tool is built to keep bounded.
  notes?: string[];
};

// declaredModules replaces modules/kinds as the required field, the same
// class of config error as a missing kinds used to be: check/todo build
// their graph from declaredModules unconditionally now, so a config
// without it cannot be analyzed at all - `archstrict init` is what writes
// it.
const REQUIRED_FIELDS = ["declaredModules", "because"] as const;

// A config file cannot know its own path (init.ts's own generated template
// says the same); the loader is what adds it, after reading the file, not
// before.
//
// Reads the source and strips types with the TypeScript compiler API
// itself (this project's own dependency), then imports the result as a
// data: URL, rather than a plain `import(pathToFileURL(configPath).href)`
// of the file directly. A file-path import is cached by Node's ESM loader
// keyed on that exact URL, so importing the same path twice in one
// process returns the first import's stale object even after the file
// changed on disk since - measured directly. A real CLI invocation is a
// fresh process each time and never hits this, but this project's own
// test suite calls loadConfig more than once per process, which is
// exactly how the staleness surfaced. A data: URL's content IS its
// identity, so a changed file naturally produces a different URL and a
// fresh module; identical content correctly reuses the cache.
//
// Constraint this puts on a config file: its only import must be a
// type-only one (`import type { Config } from "./archstrict.types.js"`,
// exactly what init writes). `verbatimModuleSyntax` erases a type-only
// import completely, leaving no import statement in the transpiled output
// for the data: URL to resolve. A plain `import { Config } from "..."` (no
// `type` keyword) is NOT erased - transpileModule works one file at a
// time and cannot see that `Config` is only ever used as a type - so it
// survives into the output and fails to resolve against a data: URL, which
// has no directory of its own. Checked for below, with a clear error
// instead of that opaque resolution failure.
// Proposed source uses the same content-keyed URL, so a changed proposal cannot reuse a stale config module.
//
// `verb` is the command a thrown error's `do:` tells the caller to re-run
// once the file is fixed. init's own two calls pass "archstrict init": a
// re-run's do: pointing at `archstrict check` would send the caller to a
// command that never regenerates archstrict.types.ts, the file init's own
// load exists to write. Only errors thrown directly here take `verb` -
// assertSchemaVersion and assertEdgesShapeValid are shared with other
// verbs and keep their own fixed "archstrict check", unchanged.
export async function loadConfig(configPath: string, sourceOverride?: string, verb = "archstrict check"): Promise<Config> {
  // init is what creates this file. A missing one is the first-run path,
  // and a raw ENOENT doesn't name that command.
  if (sourceOverride === undefined && !existsSync(configPath)) {
    throw new ReportError(`${configPath} does not exist`, "archstrict init");
  }
  const source = sourceOverride ?? readFileSync(configPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
  });
  if (/^\s*import\b/m.test(outputText)) {
    throw new ReportError(
      `${configPath} may only import types from "./archstrict.types.js" - use \`import type\`, not \`import\``,
      `change the import in ${configPath} to \`import type\`, then run ${verb}`,
    );
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  const mod: unknown = await import(dataUrl);
  const raw = (mod as { default?: unknown }).default;
  if (raw === undefined || typeof raw !== "object" || raw === null) {
    throw new ReportError(
      `${configPath} has no default export`,
      `add a default export satisfying Config to ${configPath}, then run ${verb}`,
    );
  }
  assertSchemaVersion(configPath, raw);
  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw)) {
      throw new ReportError(
        `${configPath} is missing required field '${field}'`,
        `add '${field}' to the default export in ${configPath}, then run ${verb}`,
      );
    }
  }
  assertDeclaredModulesShapeValid(configPath, raw, verb);
  const config = { ...(raw as object), configPath } as Config;
  assertEdgesShapeValid(config);
  assertGlobsSupported(config, verb);
  return config;
}

// `field in raw` (REQUIRED_FIELDS above) only checks presence, not shape:
// `declaredModules: null` or `declaredModules: undefined` both satisfy
// `in` and passed straight through to init's `.map`, which then either
// threw a raw TypeError (check) or produced `ModuleName = never` /
// `"a" | ;` - invalid TypeScript - written over the last good union
// (init). Every reader of `config.declaredModules` (buildModuleGraph,
// init's own union writer) depends on it actually being an array of
// `{ name: non-empty string, glob: string }`, so that shape is validated
// once, here, rather than trusted at every call site.
function assertDeclaredModulesShapeValid(configPath: string, raw: object, verb: string): void {
  const declaredModules = (raw as { declaredModules?: unknown }).declaredModules;
  if (!Array.isArray(declaredModules)) {
    throw new ReportError(
      `${configPath} field 'declaredModules' must be an array, not ${describeShape(declaredModules)}`,
      `make 'declaredModules' an array of { name, glob } entries in ${configPath}, then run ${verb}`,
    );
  }
  declaredModules.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ReportError(
        `${configPath} field 'declaredModules[${i}]' must be an object, not ${describeShape(entry)}`,
        `make 'declaredModules[${i}]' an object with a 'name' and a 'glob' in ${configPath}, then run ${verb}`,
      );
    }
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length === 0) {
      throw new ReportError(
        `${configPath} field 'declaredModules[${i}].name' must be a non-empty string, got an empty string`,
        `give 'declaredModules[${i}]' a non-empty string 'name' in ${configPath}, then run ${verb}`,
      );
    }
    if (typeof name !== "string") {
      throw new ReportError(
        `${configPath} field 'declaredModules[${i}].name' must be a non-empty string, not ${describeShape(name)}`,
        `give 'declaredModules[${i}]' a non-empty string 'name' in ${configPath}, then run ${verb}`,
      );
    }
    const glob = (entry as { glob?: unknown }).glob;
    if (typeof glob !== "string") {
      throw new ReportError(
        `${configPath} field 'declaredModules[${i}].glob' must be a string, not ${describeShape(glob)}`,
        `give 'declaredModules[${i}]' a string 'glob' in ${configPath}, then run ${verb}`,
      );
    }
  });
}

function allProjectRelativeFiles(graph: ModuleGraph): string[] {
  const files = [...graph.modules.values()].flatMap((m) => m.files).concat(graph.outsideFiles);
  return files.map(graph.relativePath);
}

// A scoped specifier's own two segments ("@scope/name") are the meaningful
// grouping unit - "@scope" alone would merge every package under one scope
// into a single, useless bucket. A relative or unscoped specifier groups by
// its own first segment only.
function specifierPrefix(specifier: string): string {
  const segments = specifier.split("/");
  if (specifier.startsWith("@") && segments.length > 1) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0]!;
}

function unresolvedSpecifierBreakdown(specifiers: string[]): { prefix: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const specifier of specifiers) {
    const prefix = specifierPrefix(specifier);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([prefix, count]) => ({ prefix, count }));
}

export type RunRulesOptions = {
  configLocator?: ConfigLocator;
  // Set by check() when a `check <file>` run named a file that is not any
  // module's own surface file: rule 6's own violations are always
  // reported at a surface-file path (checkTypeLeaks below groups every
  // finding under `group.path = surfacePath`), so a report scoped to a
  // non-surface file can never contain one - running it at all would only
  // force a whole-project ts.Program into existence for a rule whose
  // answer the scoped report throws away. simulate.ts never sets this: it
  // has no file scope, and its `before`/`after` diff needs every rule
  // evaluated on both sides.
  skipTypeLeak?: boolean;
  // The module whose surface contains `focus`. Rule 6 needs the module name
  // to build one closure. Inferring the name inside the rule is refused because the
  // rule does not own path canonicalization or module-surface selection.
  focusedTypeLeakModule?: string;
  // Called right after rule 6 and before every other rule. check() uses
  // it to drop rule 6's Program there, so the Program and the other
  // rules' violations never sit in memory together: on a large codebase
  // each alone fits Node's default heap, but the two together do not.
  afterTypeLeak?: () => void;
  // check()'s own realpath'd target for a `check <file>` run - the exact
  // value `filterToFile` itself compares a violation's own (resolved)
  // `path` against. Passed down to the rules whose violations report at
  // one real file (public-surface-bypass, tag-boundary/tag-order/point-
  // rule, must-be-empty, uncovered-module), so each builds only the
  // violations reachable from that one file, instead of every one in the
  // project and then throwing away all but a handful. Every other rule
  // (cycles, and everything that reports at config.configPath) still runs
  // its own current, whole-project logic unconditionally - `focus` only
  // changes what gets returned, through the end-of-function filter below,
  // never what those rules compute. undefined for a full `check`, for a
  // `check <file>` whose named file doesn't exist, and for a `check <dir>`
  // (or anything else that isn't a regular file): check()'s own
  // tryRealpath only returns a value for a real, existing, regular file,
  // so every rule runs unscoped in every other case, and either
  // `filterToFile` throws its usual "no such file" error (a missing
  // path), or narrows the unscoped result the same way it always has (a
  // directory, or any other non-file target - stale-todo and clean-
  // module-has-todo both report at a module's own directory, which
  // `filterToFile` can still match directly).
  focus?: string;
};

// The exact predicate `filterToFile` itself applies to a violation's own
// `path` - shared so every early-filtering call site above narrows down to
// precisely the set `filterToFile` would keep from an unscoped run. Most
// of this file's own violations carry an already-absolute, already-real
// `path` (an edge's own `fromFile`, or a module's own directory) and are
// compared directly instead, for the edges the cost of this call would
// itself add back (checkPublicSurfaceBypass's own comment has the
// reasoning) - `resolve()` here exists for the one path shape that needs
// it: must-be-empty's own `path` is project-relative, resolved against
// `process.cwd()`, the same as `filterToFile` resolves the `file` a
// caller named.
function reportedAtFocus(path: string, focus: string): boolean {
  return resolve(path) === focus;
}

export function runRules(graph: ModuleGraph, config: Config, options: RunRulesOptions = {}): CheckResult {
  // null (not 0, not an empty array's own .length) when this rule did not
  // run: "not evaluated" and "evaluated, found none" are different facts,
  // and CheckResult.typeLeaks's own comment is the field this distinction
  // exists for. Rule 6 runs first so that its Program can be released
  // (options.afterTypeLeak) before the other rules build their own
  // violations; its findings still go last in the report. The `typeLeaks`
  // count stays whole-project for a full
  // run. A surface-focused run counts only findings at that surface.
  // A non-surface focus cannot receive a rule-6 finding, so evaluation is
  // refused. A surface focus uses the separate scoped graph path because an
  // all-surface closure found 53 leaks to report 4 on a 23,000-file project.
  const allTypeLeaks = options.skipTypeLeak ? undefined : options.focusedTypeLeakModule === undefined
    ? checkTypeLeaks(graph)
    : graph.typeLeaksForFocus(options.focusedTypeLeakModule);
  // A focused module can have several surfaces. Counting every surface is
  // refused because `check <file>` reports facts about one requested file.
  const typeLeaks = allTypeLeaks === undefined || options.focus === undefined
    ? allTypeLeaks
    : allTypeLeaks.filter((violation) => reportedAtFocus(violation.path, options.focus!));
  options.afterTypeLeak?.();
  const focus = options.focus;

  const mustBeEmptyFiles = allProjectRelativeFiles(graph);
  const violations: RawViolation[] = [
    ...checkPublicSurfaceBypass(graph, focus),
    ...checkCycles(graph, config),
    ...checkStaleCycleExceptions(graph, config),
    ...checkUncoveredModules(graph, config, focus),
    ...checkEmptyRuleSet(graph, config),
    ...checkMustBeEmpty(
      focus === undefined ? mustBeEmptyFiles : mustBeEmptyFiles.filter((f) => reportedAtFocus(f, focus)),
      config,
    ),
    ...checkAllowDeny(graph, config, focus),
    ...checkOrder(graph, config, focus),
    ...checkPoint(graph, config, focus),
  ];
  const deprecated = checkDeprecatedEdges(graph, config);
  violations.push(...deprecated.violations);
  if (typeLeaks !== undefined) violations.push(...typeLeaks);

  const modulesWithoutSurfaceNames: string[] = [];
  for (const m of graph.modules.values()) {
    if (m.surfaceFiles.length === 0) modulesWithoutSurfaceNames.push(m.name);
  }
  modulesWithoutSurfaceNames.sort();

  // Every rule above either already builds only focus-matching violations
  // (the early filters just passed in), or still runs fully and returns
  // every one of its own findings (cycles; every config.configPath-only
  // rule) - this pass is what makes the two the same either way: it keeps
  // exactly what `filterToFile` would keep from a fully unscoped run, so
  // `runRules`'s own return value is already the scoped result, not an
  // approximation of it. Graph counts and edge coverage stay whole-project
  // facts. Violations, todo, and a surface run's type-leak count are scoped.
  const scopedViolations = focus === undefined ? violations : violations.filter((v) => reportedAtFocus(v.path, focus));
  const locator = options.configLocator ?? createConfigLocator(config);

  return {
    modules: graph.modules.size,
    modulesWithoutSurface: modulesWithoutSurfaceNames.length,
    modulesWithoutSurfaceNames,
    edges: graph.crossModuleEdges.length,
    outsideFiles: graph.outsideFiles.length,
    nonTsSourceFiles: graph.nonTsSourceFileCount,
    unresolvedSpecifiers: graph.unresolvedSpecifierCount,
    unresolvedSpecifierBreakdown: unresolvedSpecifierBreakdown(graph.unresolvedSpecifiers),
    unsupportedSyntax: graph.unsupportedSyntaxCount,
    typeLeaks: typeLeaks === undefined ? null : typeLeaks.length,
    todo: 0,
    violations: locateViolations(scopedViolations, config, locator),
    suggestions: deprecated.suggestions,
    edgeRuleCoverage: checkEdgesCoverage(graph, config),
  };
}

// check <file>: analyze the whole project (module resolution needs every
// file to know what an edge crosses into), but report only the named
// path's own violations — analysis is whole-project, but the report is
// scoped to the one path asked about. Rule 6 uses a module's surface file
// as its own `path`, so it CAN match this filter (editing a surface file
// directly). Rules 2-5 use a module directory or the config file as their
// own `path`, never a single source file, so they never match this filter
// by design: a per-file hook cares about the edited file's own edges (rule
// 1, and rule 6), not a module- or config-level finding that no single
// file edit could have caused.
//
// `file` and a violation's own `path` can each name the same real file in
// a different textual form - one reached through a symlink, the other
// not (measured directly: a process chdir'd into a symlinked directory
// has its own process.cwd() come back already resolved, with no way to
// see the symlinked form again; a caller-supplied `file` carries whatever
// form it arrived in, independently). Comparing the two strings as given
// then silently matches nothing. `realpathSync` resolves `file` - the one
// path this function has any reason to distrust. A violation's own
// `path` never gets its own `realpathSync` call here: every one of them
// is already real by the time it reaches this filter - a module- or
// file-derived path comes from `graph.rootDir` (itself realpath'd once,
// in prepareGraph) joined onto a project-relative fragment, and a
// config-meaning violation's own path comes from `check()`'s own
// `configPath`, realpath'd once there for exactly this reason. Calling
// `realpathSync` per violation instead of `resolve` (a pure string op,
// no filesystem call) measured at 3.4% of a whole `check` run on a
// 23,000-file tree, almost all of it inside this one loop.
export function filterToFile(result: CheckResult, file: string): CheckResult {
  const resolved = resolve(file);
  if (!existsSync(resolved)) {
    throw new ReportError(`check ${file}: no such file`, "archstrict check");
  }
  const target = realpathSync(resolved);
  return { ...result, violations: result.violations.filter((v) => resolve(v.path) === target) };
}

function isFreezable(v: AnyViolation): v is AnyViolation & { todoModule: string } {
  return "todoModule" in v;
}

// Suppresses a violation whose fingerprint is already frozen into its
// module's todo (counted into `todo`, not the exit code), flags a todo
// entry that matches no current violation as its own violation
// (import-linter's own default for the same case: an unmatched ignore is
// an error, not a silent pass) — a todo entry cannot be left behind once
// what it named is gone — and flags a module configured to stay clean
// (config's `strict` list) that has any todo entries at all: staying
// clean means "done," not "frozen at whatever debt existed when the
// module was added to that list." A first draft only blocked *adding* to
// such a module's todo, which let existing entries sit there unnoticed
// forever — the same shape packwerk's own `enforce_dependencies: strict`
// refuses.
export type ApplyTodoOptions = {
  configLocator?: ConfigLocator;
  // check() sets this to ["type-leak"] on a `check <file>` run scoped to a
  // non-surface file, the same run that told runRules to skip rule 6
  // entirely (RunRulesOptions.skipTypeLeak's own comment). Without this,
  // every OTHER module's frozen type-leak entries - unrelated to the
  // scoped file, never evaluated this run - would read as unmatched and
  // get reported as stale-todo, when their real status (still a leak, or
  // fixed) is simply unknown this run, not "gone".
  skipStaleCheckForRules?: readonly string[];
  // check()'s own realpath'd target for a `check <file>` run - the same
  // value passed to runRules as its own `focus`. Gates the stale-todo
  // check below down to the todo entries whose OWN stored `path` is that
  // one file - never the matching loop above it, which already only ever
  // sees `result.violations`, already narrowed to `focus` by runRules
  // (see RunRulesOptions.focus's own comment) before this function runs
  // at all.
  focus?: string;
  // `check --frozen`'s own request: a todo-matched violation is kept in
  // `remaining` (marked `frozen: true`) instead of only counted in
  // `suppressed`. Absent (the default) reproduces the exact behavior
  // before this option existed - a matched violation vanishes from the
  // returned list entirely.
  includeFrozen?: boolean;
};

// An entry's own stored `path` (todo-store.ts's own TodoEntry, always
// present, always project-relative to `rootDir` - todo.ts's own
// freezeOrPrune writes it that way, and both readTodoFile and the legacy
// reader normalize an old absolute one into the same form) resolved back
// to the real, absolute file it names, compared against `focus`. A
// public-surface-bypass or constraint-engine entry frozen under module M's
// own name records the IMPORTER's path, not M's own - the same reason
// those two rules' own Violation.path is the importer (public-surface.ts's
// own comment) - so this can differ from M's own directory even when M
// itself is the file being checked.
function entryReportedAtFocus(entry: TodoEntry, rootDir: string, focus: string): boolean {
  return resolve(rootDir, entry.path) === focus;
}

// Where a stale-todo/clean-module-has-todo violation points: at the exact
// line inside the single archstrict.todo.json when the project has
// already migrated to it (parsed !== undefined - todo-store.ts's own
// ParsedTodoFile keeps each entry's and each module key's own real
// position), or at the module's own directory (line 1, column 1, the
// pre-migration shape) while a project is still being read through the
// old per-module layout - which never has more than one entry's worth of
// position to offer anyway, since todo-migration.ts's own reader doesn't
// track positions at all (that layout is going away, not worth building
// position-tracking for).
type TodoLocation = { path: string; line: number; column: number };

function moduleTodoLocation(parsed: ParsedTodoFile | undefined, moduleDir: string | undefined, name: string): TodoLocation {
  if (parsed !== undefined) {
    const at = parsed.moduleKeyLocation.get(name);
    return { path: parsed.path, line: at?.line ?? 1, column: at?.column ?? 1 };
  }
  // Only reached on the pre-migration layout, where moduleDir is always
  // defined - readLegacyTodoState only ever reads a name the live graph
  // already declares, so it never produces an orphan entry.
  return { path: moduleDir!, line: 1, column: 1 };
}

function entryTodoLocation(parsed: ParsedTodoFile | undefined, moduleDir: string | undefined, entry: TodoEntry): TodoLocation {
  if (parsed !== undefined) {
    const at = parsed.entryLocation.get(entry);
    return { path: parsed.path, line: at?.line ?? 1, column: at?.column ?? 1 };
  }
  return { path: moduleDir!, line: 1, column: 1 };
}

// One read of the whole file, shared by every caller that needs current
// frozen debt (applyTodo below; hotspots.ts's own per-module debt count):
// todo-store.ts's own readTodoFile parses it once, and a per-violation or
// per-module read would reparse the same file that many times on a
// project with tens of thousands of violations. `parsed` is the new
// single-file layout; `legacy` is consulted only when it's absent, and
// only for the module directories this run's own graph actually declares
// (readLegacyTodoState's own comment covers why a renamed module's old
// entries are unreachable by name alone either way).
export type CurrentTodo = {
  parsed: ParsedTodoFile | undefined;
  entriesByModule: ReadonlyMap<string, TodoEntry[]>;
  // Set when the new file is absent but the old per-module layout (or its
  // marker) was found - a project adopted under that layout, not migrated
  // since. Undefined once the new file exists, even if a stray legacy file
  // somehow still sits on disk (todo.ts's own freezeOrPrune is the only
  // thing that deletes them, and only after writing the new file first).
  migrationNote: string | undefined;
};

export function readCurrentTodo(graph: ModuleGraph): CurrentTodo {
  const parsed = readTodoFile(graph.rootDir);
  const moduleDirs = new Map<string, string>([...graph.modules].map(([name, m]) => [name, m.dir]));
  const legacy = parsed === undefined ? readLegacyTodoState(graph.rootDir, moduleDirs) : undefined;
  const entriesByModule = new Map<string, TodoEntry[]>();
  if (parsed !== undefined) {
    for (const [name, entries] of parsed.modules) entriesByModule.set(name, entries);
  } else if (legacy !== undefined) {
    for (const [name, entries] of legacy.entriesByModule) entriesByModule.set(name, entries);
  }
  // Prompts a one-line migration nudge in the report (result.notes, always
  // printed - check.ts's own formatText loop) instead of check silently
  // reading debt off a layout that's going away: an adopted project stays
  // green under the old layout until someone actually runs the new
  // `archstrict todo`, which folds it in and deletes the old files.
  const migrationNote = legacy?.present === true
    ? "reading frozen debt from the old per-module todo layout - run archstrict todo to migrate it into one archstrict.todo.json"
    : undefined;
  return { parsed, entriesByModule, migrationNote };
}

export function applyTodo(graph: ModuleGraph, config: Config, result: CheckResult, options: ApplyTodoOptions = {}): CheckResult {
  const skipStaleCheckForRules = new Set(options.skipStaleCheckForRules ?? []);
  const focus = options.focus;
  const strict = new Set(config.strict ?? []);
  const locator = options.configLocator ?? createConfigLocator(config);
  const remaining: AnyViolation[] = [];
  // Keyed by a freshly recomputed fingerprint (todo-store.ts's own
  // fingerprintOf), not an object identity or a stored string field (this
  // file's entries no longer carry one - todo-store.ts's own comment on
  // why): a real project can carry more than one stored entry with
  // identical content (the same edge frozen twice - runRules itself can
  // report the same edge more than once), so tracking by the recomputed
  // value means every duplicate with that fingerprint reads as matched
  // below, the same as a plain string-set comparison always did.
  const matchedByModule = new Map<string, Set<string>>();
  let suppressed = 0;

  const { parsed, entriesByModule, migrationNote } = readCurrentTodo(graph);
  const moduleDirs = new Map<string, string>([...graph.modules].map(([name, m]) => [name, m.dir]));

  const todoIndexByModule = new Map<string, TodoIndex>();
  function todoIndexFor(name: string): TodoIndex {
    let index = todoIndexByModule.get(name);
    if (index === undefined) {
      index = buildTodoIndex(entriesByModule.get(name) ?? []);
      todoIndexByModule.set(name, index);
    }
    return index;
  }

  for (const v of result.violations) {
    // A module configured to stay clean has its own violations never
    // suppressed by its todo, existing or not: a real violation there must
    // stay a real violation, not disappear into the todo count while a
    // separate clean-module-has-todo finding says the same thing from the
    // config's side.
    if (!isFreezable(v) || strict.has(v.todoModule)) {
      remaining.push(v);
      continue;
    }
    const index = graph.modules.has(v.todoModule) ? todoIndexFor(v.todoModule) : EMPTY_TODO_INDEX;
    const matchedEntry = findMatchingEntry(index, v, graph.relativePath);
    if (matchedEntry !== undefined) {
      suppressed++;
      let matched = matchedByModule.get(v.todoModule);
      if (matched === undefined) {
        matched = new Set();
        matchedByModule.set(v.todoModule, matched);
      }
      matched.add(fingerprintOf(matchedEntry));
      if (options.includeFrozen) remaining.push({ ...v, frozen: true });
    } else {
      remaining.push(v);
    }
  }

  // Every module name this file (or the old layout) has entries under -
  // a currently declared module, or an ORPHAN name a config no longer
  // declares (the module was renamed or removed since it was frozen).
  // An orphan can never match any current violation (nothing this run's
  // rules produced even claims that name), so every one of its entries is
  // unconditionally stale - reported the same as any other unmatched
  // entry below, just outside the `graph.modules` loop that also has to
  // decide strict-vs-not for a still-declared name.
  const allModuleNames = new Set<string>([...graph.modules.keys(), ...entriesByModule.keys()]);

  for (const name of allModuleNames) {
    const entries = entriesByModule.get(name) ?? [];
    if (entries.length === 0) continue;
    const moduleDir = moduleDirs.get(name);

    if (moduleDir !== undefined && strict.has(name)) {
      const at = moduleTodoLocation(parsed, moduleDir, name);
      remaining.push(locateViolation({
        rule: "clean-module-has-todo",
        path: at.path,
        line: at.line,
        column: at.column,
        evidence: `module '${name}' is configured to stay clean, but has ${entries.length} todo entrie(s)`,
        because: "a module configured to stay clean must have no todo entries, not entries frozen from before",
        do: `fix the ${entries.length} violation(s), then run archstrict todo to prune`,
      }, config, locator));
      continue; // this module's entries are never "stale" — they're a standing violation instead
    }

    const matched = matchedByModule.get(name) ?? new Set<string>();
    for (const entry of entries) {
      const at = entryTodoLocation(parsed, moduleDir, entry);
      // On a `check <file>` run, an entry recorded at some OTHER path was
      // never evaluated this run - runRules never built (or scoped away)
      // whatever violation would have matched it, so whether it's still
      // real or now fixed is unknown, not "gone" (skipStaleCheckForRules's
      // own comment makes the same call for a rule this run skipped
      // outright). Reporting it stale here would be a false positive: the
      // entry itself never got a chance to match anything this run.
      if (focus !== undefined && !entryReportedAtFocus(entry, graph.rootDir, focus)) continue;
      if (matched.has(fingerprintOf(entry))) continue;
      if (skipStaleCheckForRules.has(entry.rule)) continue;
      remaining.push(locateViolation({
        rule: "stale-todo",
        path: at.path,
        line: at.line,
        column: at.column,
        evidence: `todo entry (${entry.rule}) no longer matches any violation`,
        because: "an unmatched todo entry hides nothing real; it must be pruned, not left behind",
        do: "archstrict todo",
      }, config, locator, [{ pointer: declaredModulePointerForName(config, name), role: "governs" }]));
    }
  }

  return {
    ...result,
    violations: remaining,
    todo: suppressed,
    notes: migrationNote === undefined ? result.notes : [...(result.notes ?? []), migrationNote],
  };
}

// `--rule` needs a fixed list of valid ids to reject a typo against, rather
// than accepting anything and silently matching zero violations. Listed by
// hand instead of derived at runtime, since a rule that never fires this
// project (the current graph has no cycle, say) still has a real id an
// agent can filter for once one does appear.
export const CHECK_RULE_IDS = [
  "clean-module-has-todo",
  "config-meaning",
  "cycle",
  "deprecated-edge-decreased",
  "deprecated-edge-increased",
  "empty-rule-set",
  "exhaustive-allow-list",
  "must-be-empty",
  "point-rule",
  "public-surface-bypass",
  "stale-cycle-exception",
  "stale-todo",
  "tag-boundary",
  "tag-order",
  "type-leak",
  "uncovered-module",
] as const;

// A rule id added to AnyViolation without being added above would make
// `--rule` reject a real id as unknown. `[X] extends [never]` (rather than
// `X extends never`) keeps this from distributing away to `never` itself
// when X already is `never` - a bare conditional here would compile clean
// even while silently missing a rule id.
type MissingCheckRuleId = Exclude<AnyViolation["rule"], (typeof CHECK_RULE_IDS)[number]>;
const _checkRuleIdsCoverEveryRule: [MissingCheckRuleId] extends [never] ? true : never = true;

export type CheckOptions = {
  prove?: boolean;
  prover?: Prover;
  buildGraph?: (options: BuildOptions) => ModuleGraph;
  rules?: readonly string[];
  modules?: readonly string[];
  // Keeps a todo-matched violation in the report, marked `frozen: true`,
  // instead of dropping it - a re-architecting agent can then read a
  // module's frozen debt through the same --rule/--module filters as a
  // live violation, without opening its todo JSON by hand.
  frozen?: boolean;
};

// A frozen violation is real but already accepted as debt; it must never
// flip the exit code back to failing on a project that todo already froze.
export function hasBlockingViolations(result: CheckResult): boolean {
  return result.violations.some((v) => v.rule !== "config-meaning" && !v.frozen);
}

// Runs after the graph is built (module names depend on it) and before
// applyFilters, so a typo'd `--rule`/`--module` reports its own error
// instead of silently returning zero violations - the same distinction
// an empty, but genuinely correctly filtered, result must keep (see
// applyFilters's own comment on the empty case exiting 0).
function validateFilters(graph: ModuleGraph, options: CheckOptions): void {
  const validRules = new Set<string>(CHECK_RULE_IDS);
  for (const rule of options.rules ?? []) {
    if (!validRules.has(rule)) {
      // The `do:` is a real, runnable example (a valid id substituted in),
      // not `check --json` - that would print the whole, unbounded project
      // report, the exact shape bounded text exists to avoid.
      throw new ReportError(
        `unknown rule id '${rule}' - valid rule ids: ${CHECK_RULE_IDS.join(", ")}`,
        `archstrict check --rule ${CHECK_RULE_IDS[0]}`,
      );
    }
  }
  const validModules = [...graph.modules.keys()].sort();
  const validModuleSet = new Set(validModules);
  for (const moduleName of options.modules ?? []) {
    if (!validModuleSet.has(moduleName)) {
      throw new ReportError(
        `unknown module name '${moduleName}' - valid module names: ${validModules.join(", ")}`,
        validModules.length > 0 ? `archstrict check --module ${validModules[0]}` : "archstrict check",
      );
    }
  }
}

// Filters after every rule has already run, not before: a violation's own
// fields (todoModule, rule) are only known once the rule that produced it
// has run, and running fewer rules to satisfy `--rule` would still cost the
// same graph build for no saved work. `hasBlockingViolations` (cli.ts's own
// exit-code check) reads this same, already-filtered `result.violations`,
// so a filter given here also narrows the exit code to the filtered set,
// by construction - no separate "filtered exit code" path exists.
function applyFilters(result: CheckResult, options: CheckOptions): CheckResult {
  const rules = new Set(options.rules ?? []);
  const modules = new Set(options.modules ?? []);
  if (rules.size === 0 && modules.size === 0) return result;
  return {
    ...result,
    violations: result.violations.filter((violation) =>
      (rules.size === 0 || rules.has(violation.rule))
      && (modules.size === 0 || ("todoModule" in violation && modules.has(violation.todoModule)))),
  };
}

// True when `file` is (a real, existing path to) some module's own
// surface file - the only kind of path rule 6's own violations are ever
// reported at (checkTypeLeaks groups every finding under
// `group.path = surfacePath`). Never forces graph.program: surfaceFiles
// is plain module metadata, built before anything touches the lazy
// program/checker getters. A file that does not exist reads as "not a
// surface file" here (false) rather than throwing - the real, existing
// ReportError for that case is filterToFile's own, thrown later at its
// usual point once `focusFile` is given.
// check()'s own realpath'd target for a `check <file>` run, or undefined
// for a plain `check`, a named path that doesn't exist, or a named path
// that exists but isn't a regular file - `statSync(...).isFile()` is the
// deciding check: a directory's own realpath is just as real as a file's,
// but scoping the rules below to it is wrong, not merely unhelpful. Each
// rule this file scopes reports at ONE FILE's own path (public-surface-
// bypass and the constraint engine at `edge.fromFile`, must-be-empty and
// uncovered-module at a project file), and compares that path against
// `focus` directly - a directory can never equal a file's own path, so
// scoping to one would silently drop every real violation reachable
// through it, rather than keeping the ones inside it. `stale-todo`
// reports at a MODULE's own directory, not a file, so `check <a module's
// directory>` can produce it only by running the full, whole-project
// logic and letting `filterToFile` keep it afterward, never by scoping
// runRules to a target no rule reports at. Every other case (undefined, or a missing path) leaves
// `focus` undefined for the same reason: every rule runs full and
// unscoped, and `filterToFile` alone decides what survives - for a
// missing path, that means its own "no such file" error, thrown exactly
// where it always was.
function tryRealpath(file: string): string | undefined {
  try {
    const target = realpathSync(resolve(file));
    return statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

// Rule 6 scopes only when the requested regular file is an actual surface.
// Textual path comparison is refused because symlinks can name the same file.
function surfaceModuleForFocus(graph: ModuleGraph, file: string): string | undefined {
  let target: string;
  try {
    target = realpathSync(resolve(file));
  } catch {
    // Missing and non-resolvable paths must keep the existing unscoped error path.
    // Guessing a module is refused because `filterToFile` owns the missing-path error.
    return undefined;
  }
  for (const module of graph.modules.values()) {
    for (const surfacePath of module.surfaceFiles) {
      try {
        // The module name selects the scoped closure. Returning a boolean is
        // refused because the rule would then need to repeat the path lookup.
        if (realpathSync(surfacePath) === target) return module.name;
      } catch {
        // A configured surface glob can name a path that doesn't exist yet; not a match either way.
      }
    }
  }
  // A regular non-surface file cannot own a rule-6 report. Building any
  // Program is refused because `filterToFile` would discard every finding.
  return undefined;
}

export async function check(projectRoot: string, focusFile?: string, options: CheckOptions = {}): Promise<CheckResult> {
  const configPath = resolve(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath);
  // `config.configPath` (a config-meaning violation's own `path`) is
  // realpath'd once, here, after a successful load - `filterToFile`
  // realpaths the file it was asked about, and every other violation's
  // own `path` already comes from `graph.rootDir` (itself realpath'd in
  // prepareGraph); a config-meaning violation's own path is the one
  // exception that would otherwise stay in whatever textual form
  // `projectRoot` arrived in, comparing unequal to `filterToFile`'s own
  // realpath'd target when the two differ (a symlinked project root).
  // Done after loadConfig, not before: every error loadConfig itself can
  // throw (a missing file, a bad default export, ...) still names the
  // exact path the caller gave, not a form it never used.
  config.configPath = realpathSync(configPath);
  const configLocator = createConfigLocator(config);
  // declaredModules is the only source of scope now - loadConfig already
  // guarantees a loaded config has it, as an array of well-shaped entries
  // (assertDeclaredModulesShapeValid), not merely present. config.exclude
  // keeps a project's own root-level files (archstrict.config.ts itself,
  // dist/, etc.) out of scope entirely; `init` writes one by default.
  const graph = (options.buildGraph ?? buildModuleGraphForRules)({
    projectRoot,
    declaredModules: config.declaredModules!,
    exclude: config.exclude,
    surface: config.surface,
  });
  validateFilters(graph, options);
  // A `check <file>` scoped to a file that isn't any module's own
  // surface can never surface a rule-6 violation (filterToFile below
  // would filter it out regardless) - skip the rule so a whole-project
  // ts.Program is never built just to throw its answer away. Plain
  // `check` (no focusFile) always evaluates it.
  // Only a named surface selects scoped rule 6. Scoping a full check is
  // refused because an unscoped caller requires every module's findings.
  const focusedTypeLeakModule = focusFile === undefined ? undefined : surfaceModuleForFocus(graph, focusFile);
  // A named non-surface file cannot receive a type-leak violation. Running
  // rule 6 is refused because its complete answer would be discarded.
  const skipTypeLeak = focusFile !== undefined && focusedTypeLeakModule === undefined;
  const focus = focusFile === undefined ? undefined : tryRealpath(focusFile);
  // Rule 6 is the only rule that touches `graph.program`/`graph.checker`,
  // and runRules runs it first - release the Program right after it, so
  // the other rules never run beside it. The notes are read before the
  // release, which clears them along with the Program (a later access on
  // this graph would build a fresh one and might not need the fallback a
  // first build did). A no-op when rule 6 never ran (skipTypeLeak).
  let programNotes: readonly string[] = [];
  const evaluated = runRules(graph, config, {
    configLocator,
    skipTypeLeak,
    focusedTypeLeakModule,
    focus,
    afterTypeLeak: () => {
      // Scoped and unscoped notes have separate lifetimes. Combining them is
      // refused because a reused graph must not expose a scoped fallback later.
      programNotes = [...(focusedTypeLeakModule === undefined ? graph.programNotes : graph.focusedTypeLeakNotes)];
      graph.releaseProgram();
    },
  });
  if (skipTypeLeak) evaluated.typeLeaksSkippedFile = focusFile;
  if (programNotes.length > 0) evaluated.notes = [...programNotes];
  // Skipped outright, not merely filtered afterward, when focus names a
  // real file that isn't the config file: unlike every other rule, a real
  // call here can cost a paid, networked --prove request (config-
  // meaning.ts's own comment), and that cost must never be paid just to
  // throw the answer away.
  if (focus === undefined || focus === config.configPath) {
    evaluated.violations.push(...locateViolations(
      await checkConfigMeaning(config, options.prove ?? false, options.prover),
      config,
      configLocator,
    ));
  }
  const result = applyTodo(graph, config, evaluated, {
    configLocator,
    skipStaleCheckForRules: skipTypeLeak ? ["type-leak"] : [],
    focus,
    includeFrozen: options.frozen,
  });
  const focused = focusFile === undefined ? result : filterToFile(result, focusFile);
  return applyFilters(focused, options);
}

// The output must always carry: rule id, path:line:col, evidence, because,
// and a do: line last. "Inference" (pks's shape) is the evidence + do
// pair together, not a separate field: evidence says what was found
// ("resolved to module Y's X"), do says what to do about it.
function formatViolation(v: AnyViolation): string[] {
  const lines: string[] = [];
    lines.push(`[${v.rule}] ${v.path}:${v.line}:${v.column}`);
    if (v.frozen) lines.push("  frozen: true");
    lines.push(`  ${v.evidence}`);
    if (v.rule === "config-meaning") {
      lines.push(`  tier: ${v.tier}`);
      if (v.skipped) lines.push("  skipped: true");
      else if (v.undecided) lines.push("  undecided: true");
      else lines.push(`  confidence: ${v.confidence}`);
    }
    lines.push(`  because: ${v.because}`);
    lines.push(...formatConfigPointerLines(v.config));
    lines.push(`  do: ${v.do}`);
    if (v.rule === "tag-boundary" && v.moves?.length) {
      lines.push("  moves:");
      for (const move of v.moves) lines.push(`    ${move.kind}: ${move.do}`);
    }
  return lines;
}

// Measured against a real 31-module project: 2,191 lines (61 KB) for 435
// violations was long enough that a tool display cut the middle, forcing a
// rerun with `--json` and a separate jq pass just to see what was omitted.
// 60 lines of grouped detail stays inside one screen and one tool-display
// page even before the fixed footer below is added.
export const CHECK_DETAIL_LINE_CAP = 60;
// Not a real module: rule 2 (cycle) and every rule reporting at
// config.configPath have no module of their own to group under, and a
// filter or a group naming a real module could never match one of these.
const UNGROUPED_MODULE = "<project>";

// 80%, not "any": a project with a real, chosen surface can still have a
// handful of genuine bypasses into one module that hasn't gotten one yet -
// that's the ordinary, one-violation-at-a-time case this note is not for.
// This note is for the first-run shape instead: most bypasses sharing one
// root cause (no module in the project chose a surface at all), which "add
// a surface file" fixes project-wide, not one violation at a time.
const SURFACE_LESS_NOTE_THRESHOLD = 0.8;

function surfaceLessNote(result: CheckResult): string[] {
  const missing = new Set(result.modulesWithoutSurfaceNames);
  const bypasses = result.violations.filter((violation) => violation.rule === "public-surface-bypass");
  const missingCount = bypasses.filter((violation) =>
    "todoModule" in violation && violation.todoModule !== undefined && missing.has(violation.todoModule)).length;
  if (bypasses.length === 0 || missingCount / bypasses.length < SURFACE_LESS_NOTE_THRESHOLD) return [];
  return [
    `note: ${missingCount} of ${bypasses.length} public-surface-bypass violations target modules without a public surface`,
    "do: archstrict todo # freeze them for now",
    // `archstrict recommend --json` now proposes a ranked surface per
    // surface-less module directly from the real import graph
    // (`surfaceProposals`), instead of sending the reader to config.md to
    // guess one by hand.
    "do: archstrict recommend --json # read surfaceProposals for a ranked surface per module, from its own real importers",
  ];
}

export type ViolationGroup = { rule: string; moduleName: string; violations: AnyViolation[] };

// Exported so a test can assert on the grouping itself: once the printed
// text cuts a group's own line from view (CHECK_DETAIL_LINE_CAP), the count
// "every violation lands in exactly one group" can no longer be read back
// out of the text alone.
export function groupViolations(violations: readonly AnyViolation[]): ViolationGroup[] {
  const groups = new Map<string, ViolationGroup>();
  for (const violation of violations) {
    const moduleName = "todoModule" in violation ? violation.todoModule : UNGROUPED_MODULE;
    const key = `${violation.rule}\0${moduleName}`;
    const group = groups.get(key) ?? { rule: violation.rule, moduleName, violations: [] };
    group.violations.push(violation);
    groups.set(key, group);
  }
  // Largest group first: the cap cuts groups, not violations within a
  // group, so showing the smallest groups first (a plain alphabetical
  // sort did exactly that) buried the modules with the most real work
  // behind the cut - measured directly against nukadoko's own src (26
  // groups), where a 2-violation group printed while a 49-violation one
  // fell into "omitted". Ties break by rule id, then module name, so the
  // same input always prints the same order.
  return [...groups.values()].sort((left, right) =>
    right.violations.length - left.violations.length
    || left.rule.localeCompare(right.rule)
    || left.moduleName.localeCompare(right.moduleName));
}

function filterArgsFor(group: ViolationGroup): string {
  return group.moduleName === UNGROUPED_MODULE
    ? `--rule ${group.rule}`
    : `--rule ${group.rule} --module ${group.moduleName}`;
}

// A single group already carries exactly one rule and one module - either
// because the whole project happens to have only one, or because `--rule`/
// `--module` already narrowed to it. Its own drill-down `do:` would repeat
// the same filter and print this same truncated text again, not new
// information, so full violations are listed directly up to the cap
// instead, and `--json` (never truncated) is offered for the remainder.
function appendSingleGroupDetail(lines: string[], group: ViolationGroup): void {
  const filterArgs = filterArgsFor(group);
  let shown = 0;
  for (const violation of group.violations) {
    const block = formatViolation(violation);
    const reserve = shown + 1 < group.violations.length ? 2 : 0;
    if (lines.length + block.length + reserve > CHECK_DETAIL_LINE_CAP) break;
    lines.push(...block);
    shown++;
  }
  if (shown < group.violations.length) {
    lines.push(`violations omitted: ${group.violations.length - shown}`);
    lines.push(`do: archstrict check ${filterArgs} --json`);
  }
}

// Keeps one rule's own module/count listing on one physical line even when
// a project has dozens of surface-less modules sharing that rule. Other
// `do:` lines in this file already run past a typical terminal width, but
// a comma-joined list has no natural break of its own without a limit -
// unbounded, it would defeat the reason this summary replaced a bare
// "N omitted" count in the first place.
const OMITTED_SUMMARY_LINE_WIDTH = 100;

// The groups the cap above cut, condensed to one line per rule instead of
// dropped silently: `<rule>: <module> <count>, <module> <count>, ...`,
// each rule's own modules already in count-descending order (a subsequence
// of `ordered`, itself sorted that way). A rule's own listing truncates
// with "+N more" past OMITTED_SUMMARY_LINE_WIDTH, but always keeps at
// least its first entry, so a lone very-long module name still prints
// something rather than an empty line. The one `do:` drills into the
// single largest omitted group project-wide (`omitted[0]`, the first
// entry of a suffix of the already count-sorted `ordered`), not `--json`:
// naming the biggest remaining group is the one next step worth taking,
// not a request for the whole, unbounded report.
function summarizeOmittedGroups(omitted: readonly ViolationGroup[]): string[] {
  const byRule = new Map<string, ViolationGroup[]>();
  for (const group of omitted) {
    const groups = byRule.get(group.rule) ?? [];
    groups.push(group);
    byRule.set(group.rule, groups);
  }
  const lines: string[] = [];
  for (const ruleId of [...byRule.keys()].sort()) {
    const groups = byRule.get(ruleId)!;
    const prefix = `${ruleId}: `;
    const entries: string[] = [];
    for (const group of groups) {
      const entry = `${group.moduleName} ${group.violations.length}`;
      const candidate = [...entries, entry].join(", ");
      if (entries.length > 0 && prefix.length + candidate.length > OMITTED_SUMMARY_LINE_WIDTH) break;
      entries.push(entry);
    }
    const remainder = groups.length - entries.length;
    lines.push(`${prefix}${entries.join(", ")}${remainder > 0 ? `, +${remainder} more` : ""}`);
  }
  lines.push(`do: archstrict check ${filterArgsFor(omitted[0]!)}`);
  return lines;
}

function groupedViolationLines(result: CheckResult): string[] {
  const ordered = groupViolations(result.violations);
  const lines = [
    `violations: ${result.violations.length} in ${ordered.length} group${ordered.length === 1 ? "" : "s"}`,
    ...surfaceLessNote(result),
  ];
  if (ordered.length === 1) {
    appendSingleGroupDetail(lines, ordered[0]!);
    return lines;
  }

  const blocks = ordered.map((group) => [
    `[${group.rule}] module '${group.moduleName}': ${group.violations.length} violation(s)`,
    "  example:",
    ...formatViolation(group.violations[0]!),
    `  do: archstrict check ${filterArgsFor(group)}`,
  ]);

  // First pass: a cheap 2-line placeholder for the footer (the common
  // case - most cuts omit groups sharing one, or a handful of, rules).
  let shown = 0;
  let total = lines.length;
  for (const block of blocks) {
    const reserve = shown + 1 < ordered.length ? 2 : 0;
    if (total + block.length + reserve > CHECK_DETAIL_LINE_CAP) break;
    total += block.length;
    shown++;
  }

  // Every group fit: no footer at all, so the placeholder's guess never
  // gets checked against a real one (there is no omitted group to summarize).
  if (shown === ordered.length) {
    lines.push(...blocks.flat());
    return lines;
  }

  // The real footer (one line per distinct omitted rule, plus one `do:`)
  // can need more than the 2-line placeholder once omitted groups span
  // several rules - shrink `shown` until the real total fits, rather than
  // let the placeholder's own guess push past the cap.
  while (shown > 0) {
    const footer = summarizeOmittedGroups(ordered.slice(shown));
    const shownLines = blocks.slice(0, shown).flat();
    if (lines.length + shownLines.length + footer.length <= CHECK_DETAIL_LINE_CAP) {
      lines.push(...shownLines, ...footer);
      return lines;
    }
    shown--;
  }
  // Nothing at all fit alongside the header/note - the omitted summary
  // still prints alone, rather than the header claiming groups exist with
  // no detail about any of them.
  lines.push(...summarizeOmittedGroups(ordered));
  return lines;
}

// Up to 20 violations print in full, unchanged from before grouping
// existed: a `check <file>` run rarely exceeds this, and a project's first
// whole-project run past it is exactly the shape grouping exists for.
export function formatText(result: CheckResult): string {
  const lines: string[] = result.violations.length <= 20
    ? result.violations.flatMap(formatViolation)
    : groupedViolationLines(result);
  if (result.violations.length <= 20) lines.push(...surfaceLessNote(result));
  for (const s of result.suggestions) {
    lines.push(`[${s.rule}] ${s.path}:${s.line}:${s.column}`);
    lines.push(`  ${s.evidence}`);
    lines.push(`  do: ${s.do}`);
  }
  // One fact per line, not a comma-joined blob: an agent reading text
  // output (not JSON) reads lines, and each of these is a count where a
  // 0 could otherwise look like an omission rather than a checked fact,
  // so it is always printed, even when it's 0.
  lines.push(`modules: ${result.modules}`);
  lines.push(`modules without a public surface: ${result.modulesWithoutSurface}`);
  lines.push(`edges: ${result.edges}`);
  lines.push(`not covered by any declared module: ${result.outsideFiles}`);
  if (result.nonTsSourceFiles > 0) {
    lines.push(`non-.ts source files present, not analyzed: ${result.nonTsSourceFiles}`);
  }
  lines.push(`unresolved specifiers: ${result.unresolvedSpecifiers}`);
  if (result.unresolvedSpecifierBreakdown.length > 0) {
    const breakdown = result.unresolvedSpecifierBreakdown.map((b) => `${b.prefix} (${b.count})`).join(", ");
    lines.push(`  top unresolved prefixes: ${breakdown}`);
  }
  lines.push(`unsupported syntax: ${result.unsupportedSyntax}`);
  lines.push(result.typeLeaks === null
    ? `type leaks: not checked (${result.typeLeaksSkippedFile} is not a module surface file)`
    : `type leaks: ${result.typeLeaks}`);
  lines.push(`todo: ${result.todo}`);
  for (const note of result.notes ?? []) lines.push(`note: ${note}`);
  // A do: line only when there is a concrete next action - a clean
  // check has none, and telling the reader to re-run the command that
  // just produced this clean result is circular, unlike every other
  // do: this tool ever prints (each names the one thing to actually
  // do about a real finding). While any uncovered-module violation
  // exists, `archstrict todo` would be circular too: todo's first run
  // freezes every OTHER freezable violation, and a file matching no
  // declared module can never be frozen into a module's own todo (it
  // has no module to freeze it into) - so the fix is to cover the file
  // first, not to run todo.
  if (result.violations.some((v) => v.rule === "uncovered-module")) {
    lines.push(`do: add each uncovered-module file to declaredModules or exclude in archstrict.config.ts, then run archstrict check`);
  } else if (result.violations.some((v) => v.rule !== "config-meaning" && !v.frozen)) {
    lines.push(`do: archstrict todo`);
  }
  return lines.join("\n") + "\n";
}
