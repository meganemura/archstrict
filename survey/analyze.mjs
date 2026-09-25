// Measures the dependency boundaries one cloned repository actually keeps in
// its import graph. Read-only toward the clone except for two things the
// procedure allows: node_modules/<workspace name> symlinks (metadata only,
// no package is installed) and a throwaway archstrict.config.ts for the one
// `check --json` run. Never executes the clone's own code.
//
// usage: node survey/analyze.mjs <cloneDir> <owner/repo> <outJson> [--dir <subdir>]
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules as NODE_BUILTIN_LIST } from "node:module";
import ts from "typescript";
const NODE_BUILTINS = new Set(NODE_BUILTIN_LIST);
import { buildModuleGraph, listAnalyzedFiles } from "../dist/module-graph.js";
import { freshRun } from "../dist/verbs/init.js";
import { detectDeclared } from "./declared.mjs";

const CHECK_TIMEOUT_MS = Number(process.env.SURVEY_CHECK_TIMEOUT_MS ?? 300_000);
const HERE = dirname(fileURLToPath(import.meta.url));
const [root, fullName, outJson, ...rest] = process.argv.slice(2);
const dirArg = rest[0] === "--dir" ? rest[1] : undefined;
const t0 = Date.now();
const timings = {};
const lap = (k) => { timings[k] = Date.now() - (timings._last ?? t0); timings._last = Date.now(); };

const rel = (f) => relative(root, f).split(sep).join("/");
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

// ---- workspaces: symlink node_modules/<name> -> package dir -------------
function workspaceGlobs() {
  const pkg = readJson(join(root, "package.json")) ?? {};
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const globs = [...ws];
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    let inPackages = false;
    for (const line of readFileSync(pnpm, "utf8").split("\n")) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages && line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (m) globs.push(m[1].trim());
    }
  }
  return globs.filter((g) => !g.startsWith("!"));
}
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const NOT_MAIN_TREE = new Set(["test", "tests", "__tests__", "e2e", "fixtures", "example", "examples", "docs", "scripts", "benchmarks", "bench", "tmp", "coverage", "build"]);
function expandGlob(glob) {
  const parts = glob.replace(/\/$/, "").split("/");
  let dirs = [root];
  for (const part of parts) {
    const next = [];
    for (const d of dirs) {
      if (part === "**") {
        const stack = [d];
        while (stack.length) {
          const cur = stack.pop(); next.push(cur);
          for (const e of safeDir(cur)) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(join(cur, e.name));
        }
      } else if (part.includes("*")) {
        const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        for (const e of safeDir(d)) if (e.isDirectory() && re.test(e.name) && !SKIP_DIRS.has(e.name)) next.push(join(d, e.name));
      } else if (existsSync(join(d, part))) next.push(join(d, part));
    }
    dirs = next;
  }
  return dirs.filter((d) => existsSync(join(d, "package.json")));
}
function safeDir(d) { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } }

const workspacePkgs = [];
for (const g of workspaceGlobs()) for (const d of expandGlob(g)) {
  const name = readJson(join(d, "package.json"))?.name;
  if (name && !workspacePkgs.some((w) => w.dir === d)) workspacePkgs.push({ name, dir: d });
}
let symlinksCreated = 0;
for (const w of workspacePkgs) {
  const link = join(root, "node_modules", w.name);
  if (existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()) continue;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), w.dir), link, "dir");
  symlinksCreated++;
}
lap("workspaces");

// ---- granularity ---------------------------------------------------------
const BASE_EXCLUDE = ["archstrict.config.ts", "archstrict.types.ts", ".*/**", "**/.*/**"];
let granularity, declaredModules, exclude;
const tsCount = (d) => ts.sys.readDirectory(d, [".ts"], ["**/node_modules/**", "**/dist/**"]).filter((f) => !f.endsWith(".d.ts")).length;
const totalTs = tsCount(root);
const totalTsx = ts.sys.readDirectory(root, [".tsx"], ["**/node_modules/**", "**/dist/**"]).length;
const pkgsWithTs = workspacePkgs.filter((w) => w.dir !== root && tsCount(w.dir) > 0);
// A single wrapper directory (src/vs, packages/app/src) makes the init
// walk declare one module for the whole codebase; descend while one child
// holds >= 80% of the .ts files, and name the tree that was chosen.
function descend(start) {
  let cur = start;
  for (;;) {
    const base = join(root, cur);
    const total = tsCount(base);
    const kids = safeDir(base).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => ({ d: cur ? `${cur}/${e.name}` : e.name, n: tsCount(join(base, e.name)) })).sort((a, b) => b.n - a.n);
    if (!kids.length || kids[0].n < 0.8 * total) return cur;
    cur = kids[0].d;
  }
}
function workspaceModule(w) {
  const entry = ["src/index.ts", "index.ts", "lib/index.ts", "src/main.ts", "src/index.tsx"].find((e) => existsSync(join(w.dir, e)));
  return entry ? { name: w.name, glob: `${rel(w.dir)}/**`, surface: entry } : { name: w.name, glob: `${rel(w.dir)}/**` };
}
function scopedToTree(fr, dir) {
  // Everything outside the chosen tree is excluded, so it is neither parsed
  // nor counted.
  const top = dir.split("/")[0];
  return [...fr.exclude, ...topLevelEntries().filter((e) => e !== top).map((e) => `${e}/**`)];
}
if (dirArg) {
  const fr = freshRun(root, dirArg);
  granularity = { kind: "init-walk-of-main-tree", dir: dirArg, reason: "chosen by hand" };
  declaredModules = fr.declaredModules; exclude = scopedToTree(fr, dirArg);
} else if (totalTs > 5000) {
  // Very large codebase: one main source tree, the largest top-level
  // directory (or the single wrapper inside it).
  // Test, example, and tooling trees are never "the main source tree" even
  // when they hold the most files (a measured case: tests/ held 5,989 of
  // 10,213 files, src/ 2,373).
  const kids = safeDir(root).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && !NOT_MAIN_TREE.has(e.name))
    .map((e) => ({ d: e.name, n: tsCount(join(root, e.name)) })).sort((a, b) => b.n - a.n);
  const tree = descend(kids[0].d);
  const inTree = pkgsWithTs.filter((w) => rel(w.dir).startsWith(`${tree}/`));
  const outside = topLevelEntries().filter((e) => e !== tree.split("/")[0]).map((e) => `${e}/**`);
  if (inTree.length >= 2) {
    granularity = { kind: "workspace-package-of-main-tree", dir: tree, reason: `large codebase (${totalTs} .ts files); ${inTree.length} workspace packages under the largest tree` };
    declaredModules = inTree.map(workspaceModule); exclude = [...BASE_EXCLUDE, ...outside];
  } else {
    const fr = freshRun(root, tree);
    granularity = { kind: "init-walk-of-main-tree", dir: tree, reason: `large codebase (${totalTs} .ts files); largest tree holds ${kids[0].n}` };
    declaredModules = fr.declaredModules; exclude = scopedToTree(fr, tree);
  }
} else if (pkgsWithTs.length >= 2) {
  granularity = { kind: "workspace-package", reason: `${pkgsWithTs.length} workspace packages holding .ts` };
  // A package's exports/main usually point at build output; archstrict
  // derives those back to source when it can, otherwise take the first
  // conventional source entry that exists.
  declaredModules = pkgsWithTs.map(workspaceModule);
  exclude = BASE_EXCLUDE;
} else {
  let fr = freshRun(root, undefined);
  const opened = fr.opened;
  const tree = descend(opened);
  if (tree !== opened) {
    fr = freshRun(root, tree);
    granularity = { kind: "init-walk-of-main-tree", dir: tree, reason: `init walk of '${opened || "."}' is wrapped by one directory holding >=80% of the .ts files` };
    declaredModules = fr.declaredModules; exclude = scopedToTree(fr, tree);
  } else {
    granularity = { kind: "init-walk", opened: opened || "(project root)", noiseDirsExcluded: fr.noiseDirs };
    ({ declaredModules, exclude } = fr);
  }
}
function topLevelEntries() { return safeDir(root).map((e) => e.name); }
lap("granularity");

// ---- graph ---------------------------------------------------------------
const graph = buildModuleGraph({ projectRoot: root, declaredModules, exclude });
lap("graph");
const modules = [...graph.modules.values()].filter((m) => m.files.length > 0);
const names = modules.map((m) => m.name);
const idx = new Map(names.map((n, i) => [n, i]));
const N = names.length;
const cross = graph.crossModuleEdges.filter((e) => idx.has(e.fromModule) && idx.has(e.toModule));
const valueEdges = cross.filter((e) => !e.isTypeOnly);
const typeEdges = cross.filter((e) => e.isTypeOnly);
const isTest = (f) => { const r = rel(f); return /(^|\/)(__tests__|__mocks__|tests?|spec|test-utils?)\//.test(r) || /\.(test|spec|bench)\.tsx?$/.test(r); };
// The production view drops edges whose importing file is test code: a
// package's own tests commonly import sibling packages, which folds a clean
// layering into one big cycle that production code never has.
const prodCross = cross.filter((e) => !isTest(e.fromFile));

function adjacency(edges) {
  const adj = names.map(() => new Set());
  for (const e of edges) adj[idx.get(e.fromModule)].add(idx.get(e.toModule));
  return adj;
}

// Tarjan SCC (iterative)
function scc(adj) {
  const index = new Array(N).fill(-1), low = new Array(N).fill(0), on = new Array(N).fill(false), comp = new Array(N).fill(-1);
  const stack = []; let i = 0, c = 0;
  for (let s = 0; s < N; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, [...adj[s]], 0]];
    index[s] = low[s] = i++; stack.push(s); on[s] = true;
    while (work.length) {
      const top = work[work.length - 1]; const [v, succ] = top;
      if (top[2] < succ.length) {
        const w = succ[top[2]++];
        if (index[w] === -1) { index[w] = low[w] = i++; stack.push(w); on[w] = true; work.push([w, [...adj[w]], 0]); }
        else if (on[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[v]); }
        if (low[v] === index[v]) { let w; do { w = stack.pop(); on[w] = false; comp[w] = c; } while (w !== v); c++; }
      }
    }
  }
  return { comp, count: c };
}
function sccReport(adj) {
  const { comp, count } = scc(adj);
  const groups = Array.from({ length: count }, () => []);
  comp.forEach((c, v) => groups[c].push(names[v]));
  const big = groups.filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  return { comp, count, big };
}

const parentOf = (m) => rel(dirname(m.dir));
function structure(edgesAll) {
  const vEdges = edgesAll.filter((e) => !e.isTypeOnly);
  const vAdj = adjacency(vEdges), allAdj = adjacency(edgesAll);
  const vScc = sccReport(vAdj), allScc = sccReport(allAdj);
  // Two-module value cycles, with the edge count each way: the smallest
  // cycles are the easiest to read as "one stray import" or "mutual".
  const edgeCount = new Map();
  for (const e of vEdges) { const k = `${e.fromModule}\0${e.toModule}`; edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1); }
  const mutualPairs = [];
  for (let a = 0; a < N; a++) for (const b of vAdj[a]) if (a < b && vAdj[b].has(a))
    mutualPairs.push(`${names[a]} <-> ${names[b]} (${edgeCount.get(`${names[a]}\0${names[b]}`)}/${edgeCount.get(`${names[b]}\0${names[a]}`)})`);

  // Condensation DAG on value edges: longest path, comparability.
  const C = vScc.count;
  const cAdj = Array.from({ length: C }, () => new Set());
  for (let v = 0; v < N; v++) for (const w of vAdj[v]) if (vScc.comp[v] !== vScc.comp[w]) cAdj[vScc.comp[v]].add(vScc.comp[w]);
  const memo = new Array(C).fill(-1);
  const longest = (c) => { // edges on the longest path starting at c
    if (memo[c] >= 0) return memo[c];
    let best = 0; memo[c] = 0;
    for (const d of cAdj[c]) best = Math.max(best, 1 + longest(d));
    return (memo[c] = best);
  };
  let depth = 0; for (let c = 0; c < C; c++) depth = Math.max(depth, longest(c));
  const reach = Array.from({ length: C }, (_, c) => {
    const seen = new Set([c]); const q = [c];
    while (q.length) for (const d of cAdj[q.pop()]) if (!seen.has(d)) { seen.add(d); q.push(d); }
    return seen;
  });
  let comparable = 0, incomparable = 0, sameScc = 0;
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    const ca = vScc.comp[a], cb = vScc.comp[b];
    if (ca === cb) sameScc++;
    else if (reach[ca].has(cb) || reach[cb].has(ca)) comparable++;
    else incomparable++;
  }
  // Height = longest path down to a module that imports nothing. Not a
  // unique layering: incomparable modules at one height have no order.
  const heights = {};
  names.forEach((n, v) => { const h = longest(vScc.comp[v]); (heights[h] ??= []).push(n); });

  // Leaves and hubs (value edges, distinct importing modules).
  const inDeg = names.map(() => 0);
  for (let v = 0; v < N; v++) for (const w of vAdj[v]) inDeg[w]++;
  const leaves = names.map((n, v) => ({ module: n, inDegree: inDeg[v], files: modules[v].files.length }))
    .filter((_, v) => vAdj[v].size === 0).sort((a, b) => b.inDegree - a.inDegree);
  const hubThreshold = Math.ceil((N - 1) / 2);
  const hubs = N >= 4 ? names.map((n, v) => ({ module: n, inDegree: inDeg[v], isLeaf: vAdj[v].size === 0 }))
    .filter((h) => h.inDegree >= hubThreshold).sort((a, b) => b.inDegree - a.inDegree) : [];

  // Sibling isolation: modules sharing a parent directory, any edge kind.
  const byParent = new Map();
  modules.forEach((m, v) => { const p = parentOf(m); byParent.set(p, [...(byParent.get(p) ?? []), v]); });
  const siblingGroups = [];
  let sibPairs = 0, sibIsolated = 0;
  for (const [parent, vs] of byParent) {
    if (vs.length < 2) continue;
    let pairs = 0, iso = 0;
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      pairs++; if (!allAdj[vs[i]].has(vs[j]) && !allAdj[vs[j]].has(vs[i])) iso++;
    }
    sibPairs += pairs; sibIsolated += iso;
    siblingGroups.push({ parent: parent || ".", modules: vs.length, pairs, isolatedPairs: iso, share: +(iso / pairs).toFixed(3) });
  }
  siblingGroups.sort((a, b) => b.pairs - a.pairs);

  return {
    edges: { all: edgesAll.length, value: vEdges.length, typeOnly: edgesAll.length - vEdges.length, distinctValueModulePairs: vAdj.reduce((a, s) => a + s.size, 0) },
    cycles: { valueSccsOver1: vScc.big.length, modulesInValueCycles: vScc.big.reduce((a, g) => a + g.length, 0),
      largestValueScc: vScc.big[0]?.length ?? 0, valueSccs: vScc.big.slice(0, 5).map((g) => g.length > 12 ? [...g.slice(0, 12), `...+${g.length - 12}`] : g),
      mutualPairs: mutualPairs.slice(0, 15), mutualPairCount: mutualPairs.length,
      withTypeOnlySccsOver1: allScc.big.length, modulesInAnyCycle: allScc.big.reduce((a, g) => a + g.length, 0) },
    order: { longestPathEdges: depth, modulePairs: N * (N - 1) / 2, comparablePairs: comparable, incomparablePairs: incomparable, pairsInSameCycle: sameScc,
      heights: N <= 60 ? heights : Object.fromEntries(Object.entries(heights).map(([h, ns]) => [h, ns.length])) },
    leaves: { count: leaves.length, top: leaves.slice(0, 10) },
    hubs: { threshold: hubThreshold, list: hubs },
    siblings: { pairs: sibPairs, isolatedPairs: sibIsolated, share: sibPairs ? +(sibIsolated / sibPairs).toFixed(3) : null, groups: siblingGroups.slice(0, 8) },
  };
}
const prodStructure = structure(prodCross);
const allStructure = structure(cross);
lap("structure");

// Platform directories, over every internal resolved production edge
// (within a module too: platform splits usually live inside one tree).
const PLATFORMS = new Set(["common", "browser", "node", "worker", "client", "server", "shared"]);
const platformOf = (f) => { const segs = rel(f).split("/").slice(0, -1); let p; for (const s of segs) if (PLATFORMS.has(s) || s.startsWith("electron-")) p = s; return p; };
const allFiles = modules.flatMap((m) => m.files);
const platformFiles = {};
for (const f of allFiles) { const p = platformOf(f); if (p) platformFiles[p] = (platformFiles[p] ?? 0) + 1; }
const internal = graph.edges.filter((e) => e.toModule !== undefined && e.resolvedFile && !e.externalPackage);
const platformEdges = {};
for (const e of internal) {
  if (e.isTypeOnly || isTest(e.fromFile)) continue;
  const a = platformOf(e.fromFile), b = platformOf(e.resolvedFile);
  if (!a || !b || a === b) continue;
  const k = `${a} -> ${b}`; platformEdges[k] = (platformEdges[k] ?? 0) + 1;
}

// Public-entry discipline, production value edges.
const surfaceSet = new Map(modules.map((m) => [m.name, new Set(m.surfaceFiles)]));
let toEntry = 0, toDeep = 0, toNoSurface = 0;
const deepByTarget = {};
for (const e of prodCross) {
  if (e.isTypeOnly) continue;
  const s = surfaceSet.get(e.toModule);
  if (!s || s.size === 0) { toNoSurface++; continue; }
  if (s.has(e.resolvedFile)) toEntry++;
  else { toDeep++; deepByTarget[e.toModule] = (deepByTarget[e.toModule] ?? 0) + 1; }
}
lap("entry");

// External confinement: bare specifiers that did not resolve into the
// project, read from production files only (a test runner imported by every
// package's tests says nothing about confinement).
const internalSpec = new Set(graph.edges.filter((e) => e.toModule !== undefined).map((e) => `${e.fromFile}\0${e.specifier}`));
const pkgModules = new Map(); const builtinModules = new Map();
const pkgName = (s) => s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
const isBare = (s) => !s.startsWith(".") && !s.startsWith("/") && !/^[a-z]+:\/\//i.test(s);
const selfNames = new Set(workspacePkgs.map((w) => w.name));
const add = (map, k, mod) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(mod); };
for (const m of modules) for (const file of m.files) {
  if (isTest(file)) continue;
  let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
  const specs = ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName);
  for (const s of new Set(specs)) {
    if (!isBare(s) || internalSpec.has(`${file}\0${s}`)) continue;
    if (s.startsWith("node:") || NODE_BUILTINS.has(s.split("/")[0])) { add(builtinModules, s.replace(/^node:/, "").split("/")[0], m.name); continue; }
    const p = pkgName(s);
    // Own names and path aliases that failed to resolve are not third-party.
    if (selfNames.has(p) || /^[~#@]$|^[~#]/.test(p) || p.startsWith("@/")) continue;
    add(pkgModules, p, m.name);
  }
}
const pkgCounts = [...pkgModules].map(([p, s]) => ({ package: p, modules: s.size, importers: [...s] }))
  .sort((a, b) => b.modules - a.modules);
lap("external");

// App vs lib: production value edges between an apps/ tree and a library
// tree (packages/, libs/, lib/), at file level so it works for either
// granularity.
const top = (f) => rel(f).split("/")[0];
const APP_ROOTS = new Set(["apps", "app", "examples"]), LIB_ROOTS = new Set(["packages", "libs", "lib"]);
const appLib = { appFiles: 0, libFiles: 0, appToLib: 0, libToApp: 0, libToAppExamples: [] };
for (const f of allFiles) { if (APP_ROOTS.has(top(f))) appLib.appFiles++; else if (LIB_ROOTS.has(top(f))) appLib.libFiles++; }
for (const e of internal) {
  if (e.isTypeOnly || isTest(e.fromFile)) continue;
  const a = top(e.fromFile), b = top(e.resolvedFile);
  if (APP_ROOTS.has(a) && LIB_ROOTS.has(b)) appLib.appToLib++;
  if (LIB_ROOTS.has(a) && APP_ROOTS.has(b)) { appLib.libToApp++; if (appLib.libToAppExamples.length < 5) appLib.libToAppExamples.push(`${rel(e.fromFile)} -> ${rel(e.resolvedFile)}`); }
}

// Host/plugin inversion: a directory segment that names a plugin area.
// Plugins importing the host is expected; the host importing into the area,
// and plugins importing each other, are what the pattern keeps rare.
const PLUGIN_SEGS = new Set(["contrib", "plugins", "plugin", "extensions", "addons", "integrations", "adapters", "providers", "nodes"]);
const pluginArea = (f) => { const segs = rel(f).split("/"); for (let i = 0; i < segs.length - 2; i++) if (PLUGIN_SEGS.has(segs[i])) return { area: segs.slice(0, i + 1).join("/"), member: segs[i + 1] }; return undefined; };
const areas = new Map();
for (const f of allFiles) { const pa = pluginArea(f); if (!pa) continue; const a = areas.get(pa.area) ?? { area: pa.area, files: 0, members: new Set(), hostToPlugin: 0, pluginToHost: 0, pluginToOtherPlugin: 0, hostToPluginFiles: new Set() }; a.files++; a.members.add(pa.member); areas.set(pa.area, a); }
for (const e of internal) {
  if (e.isTypeOnly || isTest(e.fromFile)) continue;
  const pf = pluginArea(e.fromFile), pt = pluginArea(e.resolvedFile);
  if (pt && areas.has(pt.area) && (!pf || pf.area !== pt.area)) { const a = areas.get(pt.area); a.hostToPlugin++; a.hostToPluginFiles.add(rel(e.fromFile)); }
  if (pf && areas.has(pf.area) && (!pt || pt.area !== pf.area)) areas.get(pf.area).pluginToHost++;
  if (pf && pt && pf.area === pt.area && pf.member !== pt.member) areas.get(pf.area).pluginToOtherPlugin++;
}
const pluginAreas = [...areas.values()].filter((a) => a.files >= 10 && a.members.size >= 3).sort((a, b) => b.files - a.files).slice(0, 6)
  .map((a) => ({ area: a.area, files: a.files, members: a.members.size, pluginToHost: a.pluginToHost, hostToPlugin: a.hostToPlugin,
    hostFilesImportingArea: a.hostToPluginFiles.size, hostFilesExamples: [...a.hostToPluginFiles].slice(0, 5), pluginToOtherPlugin: a.pluginToOtherPlugin }));

// Test separation.
const testFiles = allFiles.filter(isTest).length;
const prodToTest = internal.filter((e) => !isTest(e.fromFile) && isTest(e.resolvedFile));

// Declared boundary config: see declared.mjs.
const declared = detectDeclared(root);
lap("misc");

// One real `archstrict check --json` for the public-surface-bypass count.
let check;
{
  writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({ schemaVersion: 1, exclude, declaredModules, because: "survey measurement: one module per granularity choice" }, null, 2)};\n`);
  let out;
  // check also runs the type-leak rule over every surface, which on a large
  // codebase costs more than the graph itself; bound it separately so a slow
  // check costs only this one number, not the repository's measurement.
  let timedOut = false;
  try { out = execFileSync("node", ["--max-old-space-size=8000", join(HERE, "../dist/cli.js"), "check", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, timeout: CHECK_TIMEOUT_MS, killSignal: "SIGKILL" }); }
  catch (e) { out = e.stdout; timedOut = e.signal === "SIGKILL"; }
  if (timedOut) out = JSON.stringify({ error: `check timed out after ${CHECK_TIMEOUT_MS / 1000}s` });
  try {
    const j = JSON.parse(out);
    const byRule = {}; for (const v of j.violations ?? []) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    const bypass = (j.violations ?? []).filter((v) => v.rule === "public-surface-bypass");
    check = { violationsByRule: byRule, publicSurfaceBypass: bypass.length, publicSurfaceBypassFromTests: bypass.filter((v) => isTest(v.path)).length, error: j.error };
  } catch (e) { check = { error: String(out ?? e).slice(0, 300) }; }
}
lap("check");
delete timings._last;

const result = {
  repo: fullName, sha, measuredAt: new Date().toISOString(), granularity,
  counts: { totalTsFiles: totalTs, totalTsxFiles: totalTsx, modules: N, analyzedFiles: allFiles.length, testFilesAnalyzed: testFiles,
    crossModuleEdges: cross.length, valueEdges: valueEdges.length, typeOnlyEdges: typeEdges.length, edgesFromTestFiles: cross.length - prodCross.length,
    unresolvedSpecifiers: graph.unresolvedSpecifierCount, distinctUnresolved: new Set(graph.unresolvedSpecifiers).size,
    workspacePackages: workspacePkgs.length, symlinksCreated },
  production: prodStructure,
  includingTests: { edges: allStructure.edges, cycles: allStructure.cycles, order: allStructure.order, siblings: { share: allStructure.siblings.share } },
  platforms: { files: platformFiles, crossPlatformValueEdges: platformEdges },
  publicEntry: { valueEdgesToEntry: toEntry, valueEdgesToDeeperFile: toDeep, valueEdgesToModuleWithoutEntry: toNoSurface,
    entryShare: toEntry + toDeep ? +(toEntry / (toEntry + toDeep)).toFixed(3) : null,
    modulesWithEntry: modules.filter((m) => m.surfaceFiles.length > 0).length,
    deepestTargets: Object.entries(deepByTarget).sort((a, b) => b[1] - a[1]).slice(0, 5) },
  external: { packages: pkgCounts.length, confinedToOneModule: pkgCounts.filter((p) => p.modules === 1).length,
    confined: pkgCounts.filter((p) => p.modules === 1).slice(0, 40).map((p) => `${p.package} <- ${p.importers[0]}`),
    widest: pkgCounts.slice(0, 10).map((p) => `${p.package}: ${p.modules}`),
    nodeBuiltins: [...builtinModules].map(([b, s]) => ({ builtin: b, modules: [...s] })) },
  modules: modules.map((m) => ({ name: m.name, dir: rel(m.dir) || ".", files: m.files.length, entry: m.surfaceFiles.map(rel).slice(0, 3) })),
  appLib, pluginAreas,
  tests: { prodToTestEdges: prodToTest.length, examples: prodToTest.slice(0, 5).map((e) => `${rel(e.fromFile)} -> ${rel(e.resolvedFile)}`) },
  declaredBoundaryConfig: { present: declared.length > 0, where: declared },
  check, timingsMs: { ...timings, total: Date.now() - t0 },
};
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ repo: fullName, modules: N, cross: cross.length, ms: result.timingsMs.total }));
