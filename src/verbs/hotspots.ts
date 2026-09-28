// Responsibility: combine Git change history with the current module graph and debt.
// Boundary: this verb reports evidence; it does not choose or apply a refactor.
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { compileGlob } from "../classify.js";
import { buildModuleGraphForRules, moduleForDeclaredFile, type ModuleGraph } from "../module-graph.js";
import { readTodo } from "../todo-store.js";
import { applyTodo, loadConfig, runRules } from "./check.js";

export type RuleCounts = Record<string, number>;

export type HotspotModule = {
  name: string;
  commits: number;
  changedLines: number;
  fanIn: number;
  fanOut: number;
  frozenDebtByRule: RuleCounts;
  activeViolationsByRule: RuleCounts;
  score: number;
  do: string;
};

export type HotspotPair = {
  moduleA: string;
  moduleB: string;
  coChanges: number;
  shareOfA: number;
  shareOfB: number;
  boundary: boolean;
  hotspot: boolean;
};

export type HotspotsResult = {
  history: { available: boolean; shallow: boolean; commits: number; since: string | null; note: string | null };
  units: { commits: "commits"; changedLines: "added plus deleted lines"; shares: "fraction of module commits" };
  exclusions: ["paths outside analysis", "archstrict todo files", "archstrict.types.ts"];
  modules: HotspotModule[];
  pairs: HotspotPair[];
};

export type CommitModules = { modules: Set<string>; linesByModule: Map<string, number> };

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

export function coChangeCount(commits: readonly (readonly string[])[], a: string, b: string): number {
  let count = 0;
  for (const commit of commits) {
    const modules = new Set(commit);
    if (modules.has(a) && modules.has(b)) count++;
  }
  return count;
}

export function summarizeCommitHistory(moduleNames: readonly string[], commits: readonly CommitModules[]) {
  const commitsByModule = new Map(moduleNames.map((name) => [name, 0]));
  const linesByModule = new Map(moduleNames.map((name) => [name, 0]));
  const pairCounts = new Map<string, number>();

  for (const commit of commits) {
    const names = [...commit.modules].sort();
    for (const name of names) {
      commitsByModule.set(name, (commitsByModule.get(name) ?? 0) + 1);
      linesByModule.set(name, (linesByModule.get(name) ?? 0) + (commit.linesByModule.get(name) ?? 0));
    }
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const key = pairKey(names[i]!, names[j]!);
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs = [...pairCounts.entries()].map(([key, coChanges]) => {
    const [moduleA, moduleB] = key.split("\0") as [string, string];
    return {
      moduleA,
      moduleB,
      coChanges,
      shareOfA: coChanges / commitsByModule.get(moduleA)!,
      shareOfB: coChanges / commitsByModule.get(moduleB)!,
    };
  });
  return { commitsByModule, linesByModule, pairs };
}

function countRules(rules: Iterable<string>): RuleCounts {
  const counts: RuleCounts = {};
  for (const rule of rules) counts[rule] = (counts[rule] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function graphBoundaries(graph: ModuleGraph): Set<string> {
  const boundaries = new Set<string>();
  for (const edge of graph.crossModuleEdges) {
    if (edge.toModule !== undefined) boundaries.add(pairKey(edge.fromModule, edge.toModule));
  }
  return boundaries;
}

function fanByModule(graph: ModuleGraph): { fanIn: Map<string, number>; fanOut: Map<string, number> } {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const name of graph.modules.keys()) {
    incoming.set(name, new Set());
    outgoing.set(name, new Set());
  }
  for (const edge of graph.crossModuleEdges) {
    if (edge.toModule === undefined) continue;
    outgoing.get(edge.fromModule)?.add(edge.toModule);
    incoming.get(edge.toModule)?.add(edge.fromModule);
  }
  return {
    fanIn: new Map([...incoming].map(([name, modules]) => [name, modules.size])),
    fanOut: new Map([...outgoing].map(([name, modules]) => [name, modules.size])),
  };
}

function gitValue(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function isAnalyzedSource(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
}

async function readGitHistory(
  projectRoot: string,
  since: string | undefined,
  moduleForPath: (path: string) => string | undefined,
): Promise<{ available: boolean; shallow: boolean; commits: CommitModules[]; note: string | null }> {
  if (gitValue(projectRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return { available: false, shallow: false, commits: [], note: "Git history is unavailable because this project is not in a Git repository." };
  }
  const shallow = gitValue(projectRoot, ["rev-parse", "--is-shallow-repository"]) === "true";
  const prefix = gitValue(projectRoot, ["rev-parse", "--show-prefix"]) ?? "";
  const args = ["log", "--numstat", "--no-renames", "--format=%x1e%H"];
  if (since !== undefined) {
    const isRef = gitValue(projectRoot, ["rev-parse", "--verify", "--quiet", `${since}^{commit}`]) !== undefined;
    args.push(isRef ? `${since}..HEAD` : `--since=${since}`);
  }
  args.push("--", ".");

  const child = spawn("git", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const commits: CommitModules[] = [];
  let current: CommitModules | undefined;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.startsWith("\u001e")) {
      if (current !== undefined && current.modules.size > 0) commits.push(current);
      current = { modules: new Set(), linesByModule: new Map() };
      continue;
    }
    if (current === undefined || line.length === 0) continue;
    const firstTab = line.indexOf("\t");
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    let path = line.slice(secondTab + 1);
    if (prefix !== "") {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    const moduleName = moduleForPath(path);
    if (moduleName === undefined) continue;
    const added = Number(line.slice(0, firstTab));
    const deleted = Number(line.slice(firstTab + 1, secondTab));
    const changed = Number.isFinite(added) && Number.isFinite(deleted) ? added + deleted : 0;
    current.modules.add(moduleName);
    current.linesByModule.set(moduleName, (current.linesByModule.get(moduleName) ?? 0) + changed);
  }
  if (current !== undefined && current.modules.size > 0) commits.push(current);
  const exitCode = await new Promise<number | null>((accept) => child.once("close", accept));
  if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || "git log failed");

  const note = shallow
    ? "Git history is limited because this is a shallow clone."
    : commits.length < 2
      ? "Git history has fewer than two relevant commits, so change coupling is limited."
      : null;
  return { available: true, shallow, commits, note };
}

export async function hotspots(projectRoot: string, since?: string): Promise<HotspotsResult> {
  const configPath = resolve(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath, undefined, "archstrict hotspots");
  config.configPath = realpathSync(configPath);
  const graph = buildModuleGraphForRules({
    projectRoot,
    declaredModules: config.declaredModules!,
    exclude: config.exclude,
    surface: config.surface,
  });
  const evaluated = runRules(graph, config, { afterTypeLeak: () => graph.releaseProgram() });
  const active = applyTodo(graph, config, evaluated);
  const activeByModule = new Map<string, string[]>();
  for (const violation of active.violations) {
    if (!("todoModule" in violation) || typeof violation.todoModule !== "string") continue;
    const rules = activeByModule.get(violation.todoModule) ?? [];
    rules.push(violation.rule);
    activeByModule.set(violation.todoModule, rules);
  }

  const excluded = (config.exclude ?? []).map(compileGlob);
  const moduleCache = new Map<string, string | undefined>();
  const moduleForPath = (path: string): string | undefined => {
    if (moduleCache.has(path)) return moduleCache.get(path);
    let name: string | undefined;
    if (isAnalyzedSource(path)
      && path !== "archstrict.types.ts"
      && !path.endsWith("archstrict.todo.json")
      && !excluded.some((glob) => glob.test(path))) {
      name = moduleForDeclaredFile(resolve(projectRoot, path), projectRoot, config.declaredModules!);
    }
    moduleCache.set(path, name);
    return name;
  };
  const history = await readGitHistory(projectRoot, since, moduleForPath);
  const summary = summarizeCommitHistory([...graph.modules.keys()], history.commits);
  const fan = fanByModule(graph);
  const boundaries = graphBoundaries(graph);

  const modules = [...graph.modules.values()].map((module): HotspotModule => {
    const commits = summary.commitsByModule.get(module.name) ?? 0;
    const fanIn = fan.fanIn.get(module.name) ?? 0;
    return {
      name: module.name,
      commits,
      changedLines: summary.linesByModule.get(module.name) ?? 0,
      fanIn,
      fanOut: fan.fanOut.get(module.name) ?? 0,
      frozenDebtByRule: countRules(readTodo(module.dir, graph.rootDir).map((entry) => entry.rule)),
      activeViolationsByRule: countRules(activeByModule.get(module.name) ?? []),
      score: commits * fanIn,
      // `--module` scopes the whole rule set to one module; a single file
      // inside it (the earlier form) is not a module-level drill-down and
      // can miss the violations that made the module a hotspot. `--frozen`
      // surfaces that module's todo-matched debt alongside its live
      // violations, instead of sending the reader to its todo JSON by hand.
      do: `archstrict check --frozen --module ${module.name}`,
    };
  }).sort((a, b) => b.score - a.score || b.commits - a.commits || a.name.localeCompare(b.name));

  const pairs = summary.pairs.map((pair): HotspotPair => {
    const boundary = boundaries.has(pairKey(pair.moduleA, pair.moduleB));
    return { ...pair, boundary, hotspot: boundary && (pair.shareOfA >= 0.5 || pair.shareOfB >= 0.5) };
  }).sort((a, b) => b.coChanges - a.coChanges || a.moduleA.localeCompare(b.moduleA) || a.moduleB.localeCompare(b.moduleB));

  return {
    history: { available: history.available, shallow: history.shallow, commits: history.commits.length, since: since ?? null, note: history.note },
    units: { commits: "commits", changedLines: "added plus deleted lines", shares: "fraction of module commits" },
    exclusions: ["paths outside analysis", "archstrict todo files", "archstrict.types.ts"],
    modules,
    pairs,
  };
}

function percentage(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function ruleCountsText(counts: RuleCounts): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "none" : entries.map(([rule, count]) => `${rule}=${count}`).join(", ");
}

export function formatHotspotsText(result: HotspotsResult): string {
  const lines = [
    "Hotspot modules (top 10)",
    "Read this as: score combines change frequency with the number of modules that depend on a module.",
  ];
  if (result.history.note !== null) lines.push(`History: ${result.history.note}`);
  for (const module of result.modules.slice(0, 10)) {
    lines.push(`  ${module.name}: score ${module.score}; ${module.commits} commits; ${module.changedLines} changed lines; fan-in ${module.fanIn}; fan-out ${module.fanOut}`);
    lines.push(`    frozen debt: ${ruleCountsText(module.frozenDebtByRule)}; active: ${ruleCountsText(module.activeViolationsByRule)}`);
  }
  lines.push("", "Co-change pairs (top 10)");
  lines.push("Read this as: a boundary hotspot changes together in at least half of either module's commits and has a current dependency edge.");
  for (const pair of result.pairs.slice(0, 10)) {
    const marker = pair.hotspot ? "boundary hotspot" : pair.boundary ? "boundary" : "no boundary edge";
    lines.push(`  ${pair.moduleA} <-> ${pair.moduleB}: ${pair.coChanges} commits; ${percentage(pair.shareOfA)} of ${pair.moduleA}; ${percentage(pair.shareOfB)} of ${pair.moduleB}; ${marker}`);
  }
  lines.push("", `Excluded from history: ${result.exclusions.join(", ")}.`);
  // At most two lines: the top module (the score's own drill-down), and, when
  // one exists, the top boundary-hotspot pair. `check --frozen` now reads a
  // pair's frozen debt through the same rule/module filters as a live
  // violation, so the drill-down names that command instead of the todo
  // JSON files it used to send the reader to open by hand.
  if (result.modules.length > 0) lines.push(`do: ${result.modules[0]!.do}`);
  const pair = result.pairs.find((candidate) => candidate.hotspot);
  if (pair !== undefined) {
    lines.push(
      `do: read node_modules/archstrict/skills/archstrict/references/rearchitect.md, then run archstrict check --frozen --module ${pair.moduleA} and archstrict check --frozen --module ${pair.moduleB}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
