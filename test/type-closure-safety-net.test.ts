// Responsibility: rule 6's own closure Program (module-graph.ts's
// `ensureProgram`) has a bounded safety net - this exercises the two
// user-visible ends of it: the round bound actually stops, and the
// resulting fallback note reaches every caller that can trigger it
// (check, search, fix), in both its text and its JSON shape.
// Boundary: uses `forceClosureFallbackForTests` (module-graph.ts's own
// test-only override) to force the bound path deterministically, rather
// than construct a real project whose closure never stabilizes - real
// syntax that trips the net at all is rare enough that a determinstic
// seam is the only reliable way to reach the bound itself in a test.
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { buildPreparedGraph, prepareGraph, type DeclaredModule } from "../src/module-graph.js";
import { check, formatText } from "../src/verbs/check.js";
import { formatSearchText, type SearchResult } from "../src/verbs/search.js";
import { formatFixText, type FixResult } from "../src/verbs/fix.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak-closure");
const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];

describe("the closure's own round bound and fallback", () => {
  test("forceClosureFallbackForTests exhausts every round and falls back to the whole-project Program", () => {
    const prepared = prepareGraph({ projectRoot: FIXTURE, declaredModules });
    const graph = buildPreparedGraph(prepared, { forceClosureFallbackForTests: true });
    // Forcing the checker (rule 6) is what actually builds the Program -
    // the note is empty until then, the same as an ordinary run.
    expect(graph.programNotes).toEqual([]);
    const violations = checkTypeLeaks(graph);
    expect(violations.length).toBeGreaterThan(0); // the fallback Program still finds every real leak
    expect(graph.programNotes).toHaveLength(1);
    expect(graph.programNotes[0]).toMatch(/rule 6's type closure could not resolve every referenced import/);
    expect(graph.programNotes[0]).not.toMatch(/\bstrict\b|\btyped\b/);
  });

  test("check's own notes reach both its text and its JSON shape", async () => {
    const result = await check(FIXTURE, undefined, {
      buildGraph: (options) => buildPreparedGraph(prepareGraph(options), { forceClosureFallbackForTests: true }),
    });
    expect(result.notes).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result)).notes).toEqual(result.notes);
    expect(formatText(result)).toContain(`note: ${result.notes![0]}`);
  });

  test("a focused safety fallback keeps the unscoped closure note", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-focused-fallback-notes-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","strict":true,"skipLibCheck":true}}');
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      mkdirSync(join(root, "src/a"), { recursive: true });
      mkdirSync(join(root, "src/b"), { recursive: true });
      writeFileSync(join(root, "src/a/secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src/a/index.ts"), 'import type { Secret } from "./secret.js";\nexport interface A { value: Secret }\n');
      writeFileSync(join(root, "src/b/index.ts"), "export interface B { value: number }\n");
      writeFileSync(join(root, "src/b/augment.ts"), 'export {};\ndeclare module "../a/index.js" { interface A { extra: string } }\n');
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
        exclude: ["archstrict.config.ts", "tsconfig.json"], because: "test architecture",
      })};`);

      const result = await check(root, join(root, "src/a/index.ts"), {
        buildGraph: (options) => buildPreparedGraph(prepareGraph(options), { forceClosureFallbackForTests: true }),
      });
      expect(result.notes).toHaveLength(1);
      expect(result.notes![0]).toContain("could not resolve every referenced import");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The safety net's own one direction: an unresolved alias, carrying a
// specifier the edge records already resolve. Dropping one re-export hop
// simulates a genuine gap in type-closure.ts's own rules: the surface's
// own public name for Secret can no longer resolve on round 0, so
// UsesSecret's own `value: Secret` property structurally leaks Secret -
// exactly the "extra finding" direction a lost public name causes. Round
// 1 recovers the hop and the name, and the leak disappears again, with
// no fallback.
describe("the safety net recovers an unresolved alias, and never falls back for a genuine type error", () => {
  test("dropFromClosureForTests: dropping a re-export hop recovers by round 1, with no fallback", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-closure-gap-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src/m/hop.ts"), 'export { Secret } from "./secret.js";\n');
      writeFileSync(join(root, "src/m/other.ts"),
        'import { Secret } from "./secret.js";\nexport interface UsesSecret { value: Secret }\n');
      writeFileSync(join(root, "src/m/index.ts"),
        'export { Secret } from "./hop.js";\nexport { UsesSecret } from "./other.js";\n');
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const prepared = prepareGraph({ projectRoot: root, declaredModules: modules });
      // hop.ts dropped on round 0 only (GraphBuildOverrides' own comment):
      // the surface's own `export { Secret } from "./hop.js"` then
      // resolves to the checker's own unknown symbol, reported with the
      // specifier ("./hop.js") - module-graph.ts's own round loop
      // resolves it through the edge records and adds hop.ts back for
      // round 1.
      const rounds: { round: number; files: readonly string[] }[] = [];
      const graph = buildPreparedGraph(prepared, {
        dropFromClosureForTests: [join(root, "src/m/hop.ts")],
        onClosureRoundForTests: (round, closureFiles) => rounds.push({ round, files: closureFiles }),
      });
      const violations = checkTypeLeaks(graph);
      expect(violations).toEqual([]); // Secret has its public name again; UsesSecret does not leak it
      expect(graph.programNotes).toEqual([]);
      // The round seam itself: round 0 really dropped hop.ts (not just a
      // no-op override), and a second round actually ran and put it back -
      // without this, "no fallback" alone cannot tell "recovered by round
      // 1" apart from "round 0 never needed hop.ts at all".
      expect(rounds.map((r) => r.round)).toEqual([0, 1]);
      expect(rounds[0]!.files).not.toContain(join(root, "src/m/hop.ts"));
      expect(rounds[1]!.files).toContain(join(root, "src/m/hop.ts"));

      const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
      const whole = checkTypeLeaks({ modules: graph.modules, program, checker: program.getTypeChecker(), rootDir: graph.rootDir });
      expect(violations.map((v) => v.evidence)).toEqual(whole.map((v) => v.evidence));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a genuinely unresolved external import in a surface's type never triggers a second round", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-closure-real-error-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "src/m"), { recursive: true });
      // "missing-package" is never installed here - a real type error
      // (TS2307 in a whole-project build too), not a closure gap: no
      // edge exists for it at all, so the net has nothing to resolve and
      // never asks for a second round.
      writeFileSync(join(root, "src/m/index.ts"),
        'import type { Foo } from "missing-package";\nexport type X = { value: Foo };\n');
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const prepared = prepareGraph({ projectRoot: root, declaredModules: modules });
      const graph = buildPreparedGraph(prepared);
      expect(graph.unresolvedSpecifierCount).toBe(1);
      const violations = checkTypeLeaks(graph);
      expect(graph.program.getRootFileNames()).toHaveLength(1); // round 0's own closure only - index.ts itself
      expect(graph.programNotes).toEqual([]);

      const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
      const whole = checkTypeLeaks({ modules: graph.modules, program, checker: program.getTypeChecker(), rootDir: graph.rootDir });
      expect(violations.map((v) => v.evidence)).toEqual(whole.map((v) => v.evidence));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// search and fix do not (yet) accept a graph-building override the way
// `check`'s own `buildGraph` option does - each is checked here at the
// format-function level instead: given a result that already carries a
// note (the same shape module-graph.ts's own `programNotes` produces),
// both the text and the JSON output carry it too.
describe("search and fix print the same note shape check does", () => {
  test("formatSearchText prints a note, and JSON.stringify keeps it", () => {
    const result: SearchResult = { query: "x", total: 0, shown: 0, matches: [], notes: ["a fallback note"] };
    expect(formatSearchText(result)).toContain("note: a fallback note");
    expect(JSON.parse(JSON.stringify(result)).notes).toEqual(["a fallback note"]);
  });

  test("formatFixText prints a note, and JSON.stringify keeps it", () => {
    const result: FixResult = { fixed: [], planned: [], unfixable: [], reverted: [], notes: ["a fallback note"] };
    expect(formatFixText(result)).toContain("note: a fallback note");
    expect(JSON.parse(JSON.stringify(result)).notes).toEqual(["a fallback note"]);
  });
});
