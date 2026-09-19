// Responsibility: the `check` verb. Loads a real archstrict.config.ts,
// builds the module graph, runs every available rule, and aggregates the
// results into one shape for JSON and text output (Q33).
// Boundary: this is where the five rules' differing return shapes get
// normalized to one — `deprecated`'s two arrays (violations/suggestions)
// flatten in here, not in each rule. Rule 6 (type leak) is not built yet;
// its slot is left open rather than guessed at.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
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

export type AnyViolation =
  | PublicSurfaceViolation
  | CycleViolation
  | UncoveredViolation
  | EmptyRuleViolation
  | DeprecatedViolation;

export type CheckResult = {
  modules: number;
  modulesWithoutPublicTs: number; // Q35's "公開面が無いモジュールが N 個" — the same fact rule 1's violations imply, restated as one count
  edges: number;
  outsideFiles: number;
  unresolvedSpecifiers: number;
  unsupportedSyntax: number;
  todo: number; // always 0 until the `todo` verb (a later ticket) exists
  violations: AnyViolation[];
  suggestions: DeprecatedSuggestion[];
};

const REQUIRED_FIELDS = ["modules", "kinds", "because"] as const;

// A config file cannot know its own path (init.ts's own generated template
// says the same); the loader is what adds it, after reading the file, not
// before.
export async function loadConfig(configPath: string): Promise<Config> {
  const mod: unknown = await import(pathToFileURL(configPath).href);
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

  let modulesWithoutPublicTs = 0;
  for (const m of graph.modules.values()) {
    if (m.publicTsPath === undefined) modulesWithoutPublicTs++;
  }

  return {
    modules: graph.modules.size,
    modulesWithoutPublicTs,
    edges: graph.crossModuleEdges.length,
    outsideFiles: graph.outsideFiles.length,
    unresolvedSpecifiers: graph.unresolvedSpecifierCount,
    unsupportedSyntax: graph.unsupportedSyntaxCount,
    todo: 0,
    violations,
    suggestions: deprecated.suggestions,
  };
}

// check <file>: analyze the whole project (module resolution needs every
// file to know what an edge crosses into), but report only the named
// path's own violations — archspec's own shape (note 1: "解析は全体、報告は
// そのパスだけ"). Rules 2-5 use a module directory or the config file as
// their own `path`, never a single source file, so they never match this
// filter by design: a per-file hook cares about the edited file's own
// edges (rule 1, and rule 6 once built), not a module- or config-level
// finding that no single file edit could have caused.
export function filterToFile(result: CheckResult, file: string): CheckResult {
  const target = resolve(file);
  return { ...result, violations: result.violations.filter((v) => v.path === target) };
}

export async function check(projectRoot: string, focusFile?: string): Promise<CheckResult> {
  const configPath = resolve(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath);
  // The config's own modules field is the source of truth, not a
  // parameter — a config saying modules: "lib/*" must scan lib/, not
  // whatever the caller happened to hard-code.
  const graph = buildModuleGraph({ projectRoot, modulesGlob: config.modules });
  const result = runRules(graph, config);
  return focusFile === undefined ? result : filterToFile(result, focusFile);
}

// Q33's unyielding conditions: rule id, path:line:col, evidence, because,
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
  // output (not JSON) reads lines, and each of these is one of the
  // project's "0 が失敗に見える" counts, recorded even when it's 0.
  lines.push(`modules: ${result.modules}`);
  lines.push(`modules without a public.ts: ${result.modulesWithoutPublicTs}`);
  lines.push(`edges: ${result.edges}`);
  lines.push(`outside the modules glob: ${result.outsideFiles}`);
  lines.push(`unresolved specifiers: ${result.unresolvedSpecifiers}`);
  lines.push(`unsupported syntax: ${result.unsupportedSyntax}`);
  lines.push(`todo: ${result.todo}`);
  lines.push(`next: ${result.violations.length > 0 ? "archstrict todo" : "archstrict check"}`);
  return lines.join("\n") + "\n";
}
