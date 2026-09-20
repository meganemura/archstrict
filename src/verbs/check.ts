// Responsibility: the `check` verb. Loads a real archstrict.config.ts,
// builds the module graph, runs every available rule, and aggregates the
// results into one shape for JSON and text output.
// Boundary: this is where the six rules' differing return shapes get
// normalized to one — `deprecated`'s two arrays (violations/suggestions)
// flatten in here, not in each rule.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { buildModuleGraph, type ModuleGraph } from "../module-graph.js";
import type { Config } from "../config.js";
import { checkPublicSurfaceBypass, type Violation as PublicSurfaceViolation } from "../rules/public-surface.js";
import { checkCycles, type Violation as CycleViolation } from "../rules/cycles.js";
import { checkUncoveredModules, type Violation as UncoveredViolation } from "../rules/uncovered.js";
import { checkEmptyRuleSet, type Violation as EmptyRuleViolation } from "../rules/empty-rule.js";
import {
  checkDeprecatedEdges,
  type Suggestion as DeprecatedSuggestion,
  type Violation as DeprecatedViolation,
} from "../rules/deprecated.js";
import { checkTypeLeaks, type Violation as TypeLeakViolation } from "../rules/type-leak.js";
import { fingerprintOf, readTodo } from "../todo-store.js";

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
  next: string;
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
  next: string;
};

export type AnyViolation =
  | PublicSurfaceViolation
  | CycleViolation
  | UncoveredViolation
  | EmptyRuleViolation
  | DeprecatedViolation
  | TypeLeakViolation
  | StaleTodoViolation
  | CleanModuleHasTodoViolation;

export type CheckResult = {
  modules: number;
  modulesWithoutSurface: number; // how many modules have no public surface present — the same fact rule 1's violations imply, restated as one count
  edges: number;
  outsideFiles: number;
  unresolvedSpecifiers: number;
  unsupportedSyntax: number;
  typeLeaks: number; // how many type-leak violations rule 6 found — 0 is a result, not silence
  todo: number; // how many violations were suppressed by a frozen todo entry
  violations: AnyViolation[];
  suggestions: DeprecatedSuggestion[];
};

const REQUIRED_FIELDS = ["modules", "kinds", "because"] as const;

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
// type-only one (`import type { Config } from "./archstrict.generated.js"`,
// exactly what init writes). `verbatimModuleSyntax` erases a type-only
// import completely, leaving no import statement in the transpiled output
// for the data: URL to resolve. A plain `import { Config } from "..."` (no
// `type` keyword) is NOT erased - transpileModule works one file at a
// time and cannot see that `Config` is only ever used as a type - so it
// survives into the output and fails to resolve against a data: URL, which
// has no directory of its own. Checked for below, with a clear error
// instead of that opaque resolution failure.
export async function loadConfig(configPath: string): Promise<Config> {
  const source = readFileSync(configPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
  });
  if (/^\s*import\b/m.test(outputText)) {
    throw new Error(
      `${configPath} may only import types from "./archstrict.generated.js" - use \`import type\`, not \`import\``,
    );
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  const mod: unknown = await import(dataUrl);
  const raw = (mod as { default?: unknown }).default;
  if (raw === undefined || typeof raw !== "object" || raw === null) {
    throw new Error(`${configPath} has no default export`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw)) {
      throw new Error(`${configPath} is missing required field '${field}'`);
    }
  }
  return { ...(raw as object), configPath } as Config;
}

export function runRules(graph: ModuleGraph, config: Config): CheckResult {
  const violations: AnyViolation[] = [
    ...checkPublicSurfaceBypass(graph),
    ...checkCycles(graph),
    ...checkUncoveredModules(graph, config),
    ...checkEmptyRuleSet(graph, config),
  ];
  const deprecated = checkDeprecatedEdges(graph, config);
  violations.push(...deprecated.violations);

  const typeLeaks = checkTypeLeaks(graph);
  violations.push(...typeLeaks);

  let modulesWithoutSurface = 0;
  for (const m of graph.modules.values()) {
    if (m.surfacePath === undefined) modulesWithoutSurface++;
  }

  return {
    modules: graph.modules.size,
    modulesWithoutSurface,
    edges: graph.crossModuleEdges.length,
    outsideFiles: graph.outsideFiles.length,
    unresolvedSpecifiers: graph.unresolvedSpecifierCount,
    unsupportedSyntax: graph.unsupportedSyntaxCount,
    typeLeaks: typeLeaks.length,
    todo: 0,
    violations,
    suggestions: deprecated.suggestions,
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
export function filterToFile(result: CheckResult, file: string): CheckResult {
  const target = resolve(file);
  return { ...result, violations: result.violations.filter((v) => v.path === target) };
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
export function applyTodo(graph: ModuleGraph, config: Config, result: CheckResult): CheckResult {
  const strict = new Set(config.strict ?? []);
  const remaining: AnyViolation[] = [];
  const matchedByModule = new Map<string, Set<string>>();
  let suppressed = 0;

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
    const targetModule = graph.modules.get(v.todoModule);
    const entries = targetModule === undefined ? [] : readTodo(targetModule.dir);
    const fp = fingerprintOf(v);
    if (entries.some((e) => e.fingerprint === fp)) {
      suppressed++;
      let matched = matchedByModule.get(v.todoModule);
      if (matched === undefined) {
        matched = new Set();
        matchedByModule.set(v.todoModule, matched);
      }
      matched.add(fp);
    } else {
      remaining.push(v);
    }
  }

  for (const [name, module] of graph.modules) {
    const entries = readTodo(module.dir);
    if (entries.length === 0) continue;

    if (strict.has(name)) {
      remaining.push({
        rule: "clean-module-has-todo",
        path: module.dir,
        line: 1,
        column: 1,
        evidence: `module '${name}' is configured to stay clean, but has ${entries.length} todo entrie(s)`,
        because: "a module configured to stay clean must have no todo entries, not entries frozen from before",
        next: `fix the ${entries.length} violation(s), then run archstrict todo to prune`,
      });
      continue; // this module's entries are never "stale" — they're a standing violation instead
    }

    const matched = matchedByModule.get(name) ?? new Set<string>();
    for (const entry of entries) {
      if (matched.has(entry.fingerprint)) continue;
      remaining.push({
        rule: "stale-todo",
        path: module.dir,
        line: 1,
        column: 1,
        evidence: `todo entry ${entry.fingerprint} (${entry.rule}) no longer matches any violation`,
        because: "an unmatched todo entry hides nothing real; it must be pruned, not left behind",
        next: "archstrict todo",
      });
    }
  }

  return { ...result, violations: remaining, todo: suppressed };
}

export async function check(projectRoot: string, focusFile?: string): Promise<CheckResult> {
  const configPath = resolve(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath);
  // The config's own modules field is the source of truth, not a
  // parameter — a config saying modules: "lib/*" must scan lib/, not
  // whatever the caller happened to hard-code.
  const graph = buildModuleGraph({ projectRoot, modulesGlob: config.modules, surface: config.surface });
  const result = applyTodo(graph, config, runRules(graph, config));
  return focusFile === undefined ? result : filterToFile(result, focusFile);
}

// The output must always carry: rule id, path:line:col, evidence, because,
// and a next: line last. "Inference" (pks's shape) is the evidence + next
// pair together, not a separate field: evidence says what was found
// ("resolved to module Y's X"), next says what to do about it.
export function formatText(result: CheckResult): string {
  const lines: string[] = [];
  for (const v of result.violations) {
    lines.push(`[${v.rule}] ${v.path}:${v.line}:${v.column}`);
    lines.push(`  ${v.evidence}`);
    lines.push(`  because: ${v.because}`);
    lines.push(`  next: ${v.next}`);
  }
  for (const s of result.suggestions) {
    lines.push(`[${s.rule}] ${s.path}:${s.line}:${s.column}`);
    lines.push(`  ${s.evidence}`);
    lines.push(`  next: ${s.next}`);
  }
  // One fact per line, not a comma-joined blob: an agent reading text
  // output (not JSON) reads lines, and each of these is a count where a
  // 0 could otherwise look like an omission rather than a checked fact,
  // so it is always printed, even when it's 0.
  lines.push(`modules: ${result.modules}`);
  lines.push(`modules without a public surface: ${result.modulesWithoutSurface}`);
  lines.push(`edges: ${result.edges}`);
  lines.push(`outside the modules glob: ${result.outsideFiles}`);
  lines.push(`unresolved specifiers: ${result.unresolvedSpecifiers}`);
  lines.push(`unsupported syntax: ${result.unsupportedSyntax}`);
  lines.push(`type leaks: ${result.typeLeaks}`);
  lines.push(`todo: ${result.todo}`);
  lines.push(`next: ${result.violations.length > 0 ? "archstrict todo" : "archstrict check"}`);
  return lines.join("\n") + "\n";
}
