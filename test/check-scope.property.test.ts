// runRules and applyTodo both accept a `focus` (check.ts's own comments on
// RunRulesOptions.focus and ApplyTodoOptions.focus have the full
// reasoning): with one, each rule builds only the violations it can ever
// report at that one file, instead of every violation in the project. This
// file holds the property the whole scoping decision has to satisfy: a
// scoped call must give exactly what an unscoped call, then filtered to
// that file, would have given - for both the violations list and the
// `todo` count (`todo` reads only the frozen entries reported at the
// focus file, not the whole project's - CheckResult.todo's own comment).
import * as assert from "node:assert/strict";
import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { applyTodo, check, filterToFile, runRules, type AnyViolation } from "../src/verbs/check.js";
import { fingerprintOf, readTodo, writeTodo } from "../src/todo-store.js";
import { todo } from "../src/verbs/todo.js";

const CONFIG = { because: "Keep app callers off shared's internals." };

function buildFixture(root: string, importerCount: number): { sharedDir: string; importers: string[] } {
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  mkdirSync(join(root, "src", "app"), { recursive: true });
  writeFileSync(join(root, "src", "shared", "index.ts"), "export const publicValue = 1;\n");
  writeFileSync(join(root, "src", "shared", "internal.ts"), "export const internalValue = 1;\n");
  const importers: string[] = [];
  for (let i = 0; i < importerCount; i++) {
    const p = join(root, "src", "app", `importer${i}.ts`);
    writeFileSync(p, `import { internalValue } from "../shared/internal.js";\nexport const v${i} = internalValue;\n`);
    importers.push(p);
  }
  return { sharedDir: join(root, "src", "shared"), importers };
}

describe("check <file> scoping equals filtering the full result", () => {
  test("scoped violations equal full violations filtered to the file; scoped todo equals full-run suppressed violations at that file", async () => {
    await hegel.testAsync(async (tc) => {
      const importerCount = tc.draw(gen.integers({ minValue: 1, maxValue: 5 }));
      const frozenMask = tc.draw(gen.arrays(gen.booleans(), { minSize: importerCount, maxSize: importerCount }));
      const includeStaleEntry = tc.draw(gen.booleans());
      const focusIndex = tc.draw(gen.integers({ minValue: 0, maxValue: importerCount + 2 }));

      const root = mkdtempSync(join(tmpdir(), "archstrict-check-scope-"));
      try {
        const { sharedDir, importers } = buildFixture(root, importerCount);
        const declaredModules = [
          { name: "shared", glob: "src/shared/**", surface: "index.ts" },
          { name: "app", glob: "src/app/**" },
        ];
        const config = { configPath: join(root, "archstrict.config.ts"), ...CONFIG, declaredModules };
        const graph = buildModuleGraph({ projectRoot: root, declaredModules });
        const unscopedEvaluated = runRules(graph, config);
        const bypassViolations = unscopedEvaluated.violations.filter(
          (v): v is AnyViolation & { todoModule: string } => v.rule === "public-surface-bypass",
        );
        assert.equal(bypassViolations.length, importerCount);

        // Freeze the entries the mask selects, keyed by each importer's own
        // real fingerprint (a genuine, still-matching entry) - plus one
        // deliberately stale entry (a plausible fingerprint for a caller
        // that does not exist on disk) when the draw asks for one, so the
        // fixture exercises both a match and a real miss.
        const toFreeze = bypassViolations.filter((_, i) => frozenMask[i]);
        const entries = toFreeze.map((v) => ({
          fingerprint: fingerprintOf(v),
          rule: v.rule,
          path: v.path,
          evidence: v.evidence,
        }));
        if (includeStaleEntry) {
          const stalePath = realpathSync(resolve(root)) + "/src/app/phantom.ts";
          entries.push({
            fingerprint: fingerprintOf({ rule: "public-surface-bypass", path: stalePath, evidence: "stale fixture entry" }),
            rule: "public-surface-bypass",
            path: stalePath,
            evidence: "stale fixture entry",
          });
        }
        writeTodo(sharedDir, entries);

        // focusIndex selects one of: an importer (has a real violation,
        // frozen or not), shared/index.ts (the target's own surface - no
        // violation of its own), or shared/internal.ts (the bypassed file
        // itself - also no violation of its own, since `path` on this rule
        // is always the IMPORTER, never the target).
        const candidates = [...importers, join(root, "src", "shared", "index.ts"), join(root, "src", "shared", "internal.ts")];
        const focusFile = candidates[Math.min(focusIndex, candidates.length - 1)]!;
        const focus = realpathSync(resolve(focusFile));

        const fullEvaluated = runRules(graph, config);
        const fullResult = applyTodo(graph, config, fullEvaluated);
        const expectedViolations = fullResult.violations
          .filter((v) => resolve(v.path) === focus)
          .sort((a, b) => a.rule.localeCompare(b.rule) || a.line - b.line || a.column - b.column);

        // The full run's own suppressed set: every freezable violation
        // runRules evaluated that applyTodo then removed (present in
        // fullEvaluated.violations, absent from fullResult.violations) -
        // filtered to the ones reported at the focus file, the same
        // predicate filterToFile itself uses.
        const remainingFingerprints = new Set(fullResult.violations.map(fingerprintOf));
        const suppressedAtFocus = fullEvaluated.violations.filter(
          (v) => "todoModule" in v && !remainingFingerprints.has(fingerprintOf(v)) && resolve(v.path) === focus,
        );

        const scopedEvaluated = runRules(graph, config, { focus });
        const scopedResult = applyTodo(graph, config, scopedEvaluated, { focus });
        const actualViolations = [...scopedResult.violations].sort(
          (a, b) => a.rule.localeCompare(b.rule) || a.line - b.line || a.column - b.column,
        );

        assert.deepEqual(actualViolations, expectedViolations);
        assert.equal(scopedResult.todo, suppressedAtFocus.length);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 25 });
  }, 30_000);
});

// The property above goes through runRules/applyTodo directly, close to
// the implementation. This second property goes through `check()` itself
// - the real verb the CLI and the PostToolUse hook call - covering the
// shapes that only show up at that level: `edges` (allowDeny/order/point),
// `friends`, `mustBeEmpty`, `ignoredCycles`, a real cycle between two
// file-modules, a real uncovered file, and five different textual forms a
// caller can hand `check()` as `focusFile` (a plain file, a module's own
// directory, the config file, a symlinked alias of a file, and a relative
// path). Bounded like test/init.property.test.ts's own P8: a small, fixed
// fixture with boolean presence toggles (not a growing tree), 20 cases,
// and a timeout override since each case builds two real ts.Programs.
describe("check() end-to-end: a scoped call equals filterToFile(a full call)", () => {
  const FIXTURE_CONFIG_TAIL = [
    "  classify: [",
    '    { glob: "src/app/**", tags: ["role:app"] },',
    '    { glob: "src/shared/**", tags: ["role:shared"] },',
    '    { glob: "src/banned/**", tags: ["role:banned"] },',
    "  ],",
    "  edges: {",
    "    allowDeny: [",
    '      { source: "role:app", targetNamespace: "role", deny: ["banned"], because: "app must not reach banned" },',
    "    ],",
    "    order: [",
    "      {",
    '        tagNamespace: "role",',
    '        sequence: { "": ["shared", "app", "banned"] },',
    '        direction: "downward-only",',
    '        because: "dependencies flow toward shared",',
    "      },",
    "    ],",
    '    point: [{ from: "src/app/**", to: "src/shared/internal.ts", because: "app must go through the shared surface" }],',
    "  },",
  ].join("\n");

  type FixtureOptions = {
    bypassPresent: boolean;
    friendPresent: boolean;
    cyclePresent: boolean;
    ignoredCyclesPresent: boolean;
    bannedFilePresent: boolean;
    orphanPresent: boolean;
    fixBypassAfterFreeze: boolean;
    breakCycleAfterFreeze: boolean;
  };

  // Every module a todo entry could ever be filed under, by its own
  // directory - hardcoded from this function's own fixture layout, not
  // read back off a built graph, so the oracle below never depends on the
  // same module-graph code the property is checking.
  function moduleDirs(root: string): { name: string; dir: string }[] {
    return [
      { name: "shared", dir: join(root, "src", "shared") },
      { name: "app", dir: join(root, "src", "app") },
      { name: "cyca", dir: join(root, "src", "cyca.ts") },
      { name: "cycb", dir: join(root, "src", "cycb.ts") },
      { name: "banned", dir: join(root, "src", "banned") },
    ];
  }

  function writeFixture(root: string, opts: FixtureOptions): void {
    mkdirSync(join(root, "src", "shared"), { recursive: true });
    mkdirSync(join(root, "src", "app"), { recursive: true });
    mkdirSync(join(root, "src", "banned"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
    writeFileSync(join(root, "src", "shared", "index.ts"), "export const p = 1;\n");
    writeFileSync(join(root, "src", "shared", "internal.ts"), "export const i = 1;\n");
    writeFileSync(
      join(root, "src", "app", "index.ts"),
      opts.bypassPresent
        ? 'import { i } from "../shared/internal.js";\nexport const a = i;\n'
        : "export const a = 1;\n",
    );
    writeFileSync(
      join(root, "src", "cyca.ts"),
      opts.cyclePresent ? 'import "./cycb.js";\nexport const cyca = 1;\n' : "export const cyca = 1;\n",
    );
    writeFileSync(
      join(root, "src", "cycb.ts"),
      opts.cyclePresent ? 'import "./cyca.js";\nexport const cycb = 1;\n' : "export const cycb = 1;\n",
    );
    if (opts.bannedFilePresent) writeFileSync(join(root, "src", "banned", "oops.ts"), "export const oops = 1;\n");
    // orphan.ts is never written here: todo's own first run refuses
    // outright while any uncovered-module violation exists (todo.ts's own
    // header comment) - writeFixtureOrphan (below) adds it AFTER that
    // first run, since it is never freezable and has no bearing on it.

    const friendsField = opts.friendPresent
      ? '  friends: [{ file: "internal.ts", from: "src/app/**", because: "app has a real friend exception" }],\n'
      : "";
    const ignoredCyclesField = opts.ignoredCyclesPresent ? '  ignoredCycles: [["cyca", "cycb"]],\n' : "";
    writeFileSync(
      join(root, "archstrict.config.ts"),
      "export default {\n" +
        "  declaredModules: [\n" +
        `    { name: "shared", glob: "src/shared/**", surface: "index.ts",\n${friendsField}    },\n` +
        '    { name: "app", glob: "src/app/**", surface: "index.ts" },\n' +
        '    { name: "cyca", glob: "src/cyca.ts", surface: "cyca.ts" },\n' +
        '    { name: "cycb", glob: "src/cycb.ts", surface: "cycb.ts" },\n' +
        '    { name: "banned", glob: "src/banned/**" },\n' +
        "  ],\n" +
        '  exclude: ["archstrict.config.ts", "tsconfig.json"],\n' +
        ignoredCyclesField +
        '  mustBeEmpty: [{ glob: "src/banned/**", because: "banned must stay empty" }],\n' +
        FIXTURE_CONFIG_TAIL +
        '\n  because: "test architecture",\n' +
        "};\n",
    );
  }

  // Which of a module's own todo entries the full run's own applyTodo call
  // suppressed (matched a still-real violation), restricted to the ones
  // recorded at `focus` - reads each module's real todo file directly
  // (todo-store.ts's own readTodo, not runRules/applyTodo), and reads
  // which entries `fullViolations` already reports as `stale-todo` (the
  // ones NOT suppressed) - every other entry, with no `strict` module in
  // this fixture, was suppressed.
  function suppressedAtFocusOracle(
    root: string,
    fullViolations: readonly { rule: string; path: string; evidence: string }[],
    focus: string,
  ): number {
    let count = 0;
    for (const { dir } of moduleDirs(root)) {
      const entries = readTodo(dir, root);
      if (entries.length === 0) continue;
      const staleFingerprints = new Set(
        fullViolations
          .filter((v) => v.rule === "stale-todo" && resolve(v.path) === resolve(dir))
          .map((v) => v.evidence.match(/^todo entry (\S+) /)?.[1]),
      );
      for (const entry of entries) {
        if (staleFingerprints.has(entry.fingerprint)) continue;
        if (resolve(join(root, entry.path)) === focus) count++;
      }
    }
    return count;
  }

  // Fields `filterToFile` never touches, and that a scoped `check()` call
  // is deliberately allowed to differ on for a reason unrelated to this
  // ticket: `typeLeaks`/`typeLeaksSkippedFile` depend on whether the
  // named file is a module's own surface (check()'s own `skipTypeLeak`,
  // predating this ticket), and `notes` only ever comes from rule 6's own
  // Program, released whenever rule 6 is skipped. `todo` is this ticket's
  // own, deliberate exception (CheckResult.todo's own comment).
  const NOT_COMPARED_DIRECTLY = new Set(["violations", "todo", "typeLeaks", "typeLeaksSkippedFile", "notes"]);

  function isRegularFile(path: string): boolean {
    try {
      return statSync(realpathSync(resolve(path))).isFile();
    } catch {
      return false;
    }
  }

  const sortViolations = (vs: readonly AnyViolation[]) =>
    [...vs].sort((a, b) => a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);

  test("check(root, focus) equals filterToFile(check(root), focus) on every field but todo; todo equals the full run's own suppressed count at focus, or the full value for a non-file focus", async () => {
    await hegel.testAsync(async (tc) => {
      const opts: FixtureOptions = {
        bypassPresent: tc.draw(gen.booleans()),
        friendPresent: tc.draw(gen.booleans()),
        cyclePresent: tc.draw(gen.booleans()),
        ignoredCyclesPresent: tc.draw(gen.booleans()),
        bannedFilePresent: tc.draw(gen.booleans()),
        orphanPresent: tc.draw(gen.booleans()),
        fixBypassAfterFreeze: tc.draw(gen.booleans()),
        breakCycleAfterFreeze: tc.draw(gen.booleans()),
      };

      const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-check-scope-e2e-")));
      let alias: string | undefined;
      try {
        writeFixture(root, opts);
        await todo(root); // freezes whatever is real and freezable right now
        if (opts.orphanPresent) writeFileSync(join(root, "src", "orphan.ts"), "export const orphan = 1;\n");

        if (opts.fixBypassAfterFreeze) writeFileSync(join(root, "src", "app", "index.ts"), "export const a = 1;\n");
        if (opts.breakCycleAfterFreeze) writeFileSync(join(root, "src", "cycb.ts"), "export const cycb = 1;\n");

        const appIndex = join(root, "src", "app", "index.ts");
        const focusPool: { label: string; file: string }[] = [
          { label: "app-index", file: appIndex },
          { label: "shared-internal", file: join(root, "src", "shared", "internal.ts") },
          { label: "shared-index", file: join(root, "src", "shared", "index.ts") },
          { label: "cyca", file: join(root, "src", "cyca.ts") },
          { label: "cycb", file: join(root, "src", "cycb.ts") },
          { label: "shared-dir", file: join(root, "src", "shared") },
          { label: "app-dir", file: join(root, "src", "app") },
          { label: "banned-dir", file: join(root, "src", "banned") },
          { label: "config", file: join(root, "archstrict.config.ts") },
          { label: "app-index-relative", file: relative(process.cwd(), appIndex) },
        ];
        if (opts.orphanPresent) focusPool.push({ label: "orphan", file: join(root, "src", "orphan.ts") });
        if (opts.bannedFilePresent) focusPool.push({ label: "banned-oops", file: join(root, "src", "banned", "oops.ts") });
        alias = join(tmpdir(), `archstrict-check-scope-e2e-alias-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
        symlinkSync(appIndex, alias);
        focusPool.push({ label: "app-index-symlink", file: alias });

        const pick = tc.draw(gen.integers({ minValue: 0, maxValue: focusPool.length - 1 }));
        const { file: focusFile } = focusPool[pick]!;

        const full = await check(root);
        const actual = await check(root, focusFile);
        const expected = filterToFile(full, focusFile);

        for (const key of Object.keys(full)) {
          if (NOT_COMPARED_DIRECTLY.has(key)) continue;
          assert.deepEqual((actual as Record<string, unknown>)[key], (full as Record<string, unknown>)[key], `field ${key}`);
        }
        assert.deepEqual(sortViolations(actual.violations), sortViolations(expected.violations));
        if (actual.typeLeaks !== null) {
          const expectedTypeLeaks = full.violations.filter(
            (violation) => violation.rule === "type-leak" && resolve(violation.path) === realpathSync(resolve(focusFile)),
          ).length;
          assert.equal(actual.typeLeaks, expectedTypeLeaks);
        }

        if (isRegularFile(focusFile)) {
          const focus = realpathSync(resolve(focusFile));
          assert.equal(actual.todo, suppressedAtFocusOracle(root, full.violations, focus));
        } else {
          assert.equal(actual.todo, full.todo);
        }
      } finally {
        if (alias !== undefined) rmSync(alias, { force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 20 });
  }, 60_000);
});
