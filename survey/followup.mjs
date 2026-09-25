// Follow-up tables over the same sample: test-origin public-surface bypasses
// and test layout, lopsided two-module cycles, size vs time and memory, and
// a .tsx baseline. Writes survey-out/followup.md and survey-out/followup.json.
//
// usage: node survey/followup.mjs [survey-out]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? new URL("../survey-out", import.meta.url).pathname;
const summary = JSON.parse(readFileSync(join(OUT, "summary.json"), "utf8"));
const repos = summary.sample.map((x) => JSON.parse(readFileSync(join(OUT, `${x.repo.replace("/", "__")}.json`), "utf8")));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const sec = (ms) => (ms == null ? "n/a" : (ms / 1000).toFixed(1));
const L = [];
const J = {};

// 1. Test-origin bypasses and test layout.
const KINDS = ["e2e/", "__tests__/", "__mocks__/", "test/ or tests/", "*.test.ts", "*.spec.ts", "fixtures/", "other (spec/, test-utils/, *.bench.ts)"];
L.push("# Follow-up measurements", "", `Same ${repos.length} repositories and commits as the main survey.`, "");
L.push("## 1. Public-surface bypasses from test files, and where tests live", "");
L.push("Each test file gets the first matching category in this order: " + KINDS.map((k) => `\`${k}\``).join(", ") + ". \"Main survey tests\" is the narrower definition the pattern counts used (it does not count `e2e/` or `fixtures/`). \"Colocated\" means the test file's directory also holds a non-test `.ts` file that was analyzed.", "");
L.push("| # | Repository | Bypasses | From tests (all categories) | From tests (main survey) | Bypasses by test category | Test files | Test files by category | Colocated |", "|---|---|---|---|---|---|---|---|---|");
let tb = 0, tt = 0, tc = 0, tf = 0; const kindBypass = {}, kindFiles = {};
J.tests = repos.map((d, i) => {
  const t = d.testLayout, b = t.bypass, fromTests = b.total - (b.byKind.production ?? 0);
  tb += b.total; tt += fromTests; tc += t.colocatedTestFiles; tf += t.testFiles;
  for (const [k, n] of Object.entries(b.byKind)) if (k !== "production") kindBypass[k] = (kindBypass[k] ?? 0) + n;
  for (const [k, n] of Object.entries(t.testFilesByKind)) kindFiles[k] = (kindFiles[k] ?? 0) + n;
  const fmt = (o) => KINDS.filter((k) => o[k]).map((k) => `${k} ${o[k]}`).join(", ") || "-";
  L.push(`| ${i + 1} | ${d.repo} | ${b.total} | ${fromTests} (${pct(fromTests, b.total)}) | ${b.fromTestsMainDefinition} | ${fmt(b.byKind)} | ${t.testFiles} | ${fmt(t.testFilesByKind)} | ${t.colocatedTestFiles} (${pct(t.colocatedTestFiles, t.testFiles)}) |`);
  return { repo: d.repo, bypasses: b.total, fromTests, fromTestsMainDefinition: b.fromTestsMainDefinition, bypassByKind: b.byKind, testFiles: t.testFiles, testFilesByKind: t.testFilesByKind, colocated: t.colocatedTestFiles };
});
const reposWithTestShare = J.tests.filter((r) => r.bypasses > 0);
const medianShare = (() => { const v = reposWithTestShare.map((r) => r.fromTests / r.bypasses).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; })();
L.push("", `Totals: ${tb} bypasses, ${tt} from test files (${pct(tt, tb)}). Across the ${reposWithTestShare.length} repositories with any bypass, the median share from tests is ${(100 * medianShare).toFixed(1)}%. Test files: ${tf}, colocated ${tc} (${pct(tc, tf)}).`, "");
L.push("| Test category | Bypasses from it | Test files in it |", "|---|---|---|");
for (const k of KINDS) L.push(`| \`${k}\` | ${kindBypass[k] ?? 0} | ${kindFiles[k] ?? 0} |`);
L.push("");

// 2. Lopsided two-module cycles (production value edges).
L.push("## 2. Two-module cycles in production code, edge counts each way", "");
L.push("Only production value edges (the importing file is not a test file, the import is not type-only). \"Majority\" is the direction with more import statements.", "");
L.push("| Repository | Pair | Majority | Minority | Ratio |", "|---|---|---|---|---|");
const pairs = [];
for (const d of repos) for (const s of d.production.cycles.mutualPairs) {
  const m = s.match(/^(.*) <-> (.*) \((\d+)\/(\d+)\)$/); if (!m) continue;
  const [a, b, ab, ba] = [m[1], m[2], +m[3], +m[4]];
  const [maj, min, majDir] = ab >= ba ? [ab, ba, `${a} -> ${b}`] : [ba, ab, `${b} -> ${a}`];
  pairs.push({ repo: d.repo, pair: `${a} <-> ${b}`, majority: maj, minority: min, majorityDirection: majDir });
}
pairs.sort((x, y) => x.repo.localeCompare(y.repo) || y.majority / y.minority - x.majority / x.minority);
for (const p of pairs) L.push(`| ${p.repo} | ${p.majorityDirection} | ${p.majority} | ${p.minority} | ${(p.majority / p.minority).toFixed(1)} |`);
const withPairs = new Set(pairs.map((p) => p.repo));
const le = (n) => pairs.filter((p) => p.minority <= n).length;
L.push("", `${pairs.length} pairs in ${withPairs.size} repositories. Minority side of 1: ${le(1)} (${pct(le(1), pairs.length)}); 1-3: ${le(3)} (${pct(le(3), pairs.length)}); 1-5: ${le(5)} (${pct(le(5), pairs.length)}). Pairs with equal counts both ways: ${pairs.filter((p) => p.majority === p.minority).length}.`, "");
const buckets = [[1, 1], [2, 3], [4, 10], [11, Infinity]];
L.push("| Minority edges | Pairs | Of which majority >= 3x minority |", "|---|---|---|");
for (const [lo, hi] of buckets) { const b = pairs.filter((p) => p.minority >= lo && p.minority <= hi); L.push(`| ${hi === Infinity ? `${lo}+` : lo === hi ? lo : `${lo}-${hi}`} | ${b.length} | ${b.filter((p) => p.majority >= 3 * p.minority).length} |`); }
L.push("");
J.pairs = pairs;

// 3. Size, time, memory.
L.push("## 3. Size, time, and peak memory", "");
L.push("Times are wall-clock seconds on a 4-core, 15 GB container, one repository at a time. \"Program\" is TypeScript's `createProgram` over the analyzed files; \"edges\" is archstrict's walk over them (it rebuilds the program from the previous one first). Peak RSS is the analyzer process's high-water mark (graph, program, and all measurements), and separately the `archstrict check --json` child's; the two run one after the other, not together.", "");
L.push("| # | Repository | .ts in repo | Files analyzed | Modules | Prepare s | Program s | Edges s | check s | Total s | Analyzer peak RSS (MB) | check peak RSS (MB) |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
J.size = repos.map((d, i) => {
  const t = d.timingsMs, r = d.peakRssMb ?? {};
  L.push(`| ${i + 1} | ${d.repo} | ${d.counts.totalTsFiles} | ${d.counts.analyzedFiles} | ${d.counts.modules} | ${sec(t.graphPrepare)} | ${sec(t.graphProgram)} | ${sec(t.graphEdges)} | ${sec(t.check)} | ${sec(t.total)} | ${Math.max(0, ...Object.entries(r).filter(([k, v]) => k !== "check" && v != null).map(([, v]) => v)) || "n/a"} | ${r.check ?? "n/a"} |`);
  return { repo: d.repo, tsFiles: d.counts.totalTsFiles, analyzedFiles: d.counts.analyzedFiles, modules: d.counts.modules, timingsMs: t, peakRssMb: r };
});
L.push("");

// 4. .tsx baseline for the repositories where .tsx outnumbers .ts.
L.push("## 4. .tsx baseline", "");
L.push("For repositories where `.tsx` files outnumber `.ts`. \"In scope\" = inside a declared module's directory. Imports are resolved with the same per-file compiler options archstrict uses; third-party packages are not installed, so most of them count as unresolved. \".ts -> .tsx edges\" are edges archstrict already sees from a `.ts` file into a `.tsx` file (today they have no target module).", "");
L.push("| Repository | .ts | .tsx | .tsx in scope | Imports from .tsx | -> .ts | distinct .ts targets | -> .ts in another module | -> .tsx | Unresolved | .ts -> .tsx edges |", "|---|---|---|---|---|---|---|---|---|---|---|");
J.tsx = repos.filter((d) => d.counts.totalTsxFiles > d.counts.totalTsFiles).map((d) => {
  const x = d.tsx;
  L.push(`| ${d.repo} | ${d.counts.totalTsFiles} | ${x.files} | ${x.filesInScope} | ${x.imports} | ${x.toTs} | ${x.toTsDistinctFiles} | ${x.toTsCrossModule} | ${x.toTsx} | ${x.unresolved} | ${x.tsToTsxEdges} |`);
  return { repo: d.repo, ts: d.counts.totalTsFiles, ...x };
});
L.push("");

writeFileSync(join(OUT, "followup.md"), L.join("\n") + "\n");
writeFileSync(join(OUT, "followup.json"), JSON.stringify(J, null, 2));
console.log(`bypasses ${tb}, from tests ${tt}; pairs ${pairs.length} in ${withPairs.size} repos, minority<=3 ${le(3)}; tsx repos ${J.tsx.length}`);
