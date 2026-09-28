import { describe, expect, test, vi } from "vitest";
import { parseTodoFileText, readTodoFile, serializeTodoFile, writeTodoFile } from "../src/todo-store.js";
import * as todoStore from "../src/todo-store.js";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { runRules, applyTodo } from "../src/verbs/check.js";

const { fingerprintOf } = todoStore;

describe("fingerprintOf", () => {
  test("a cycle violation's fingerprint excludes path, so it survives which file's edge happened to be reported", () => {
    // A cycle's `path` names one arbitrary edge's file, not the cycle
    // itself - renaming that file (or the cycle picking a different edge
    // to report on a later run) must not un-freeze an already-frozen
    // cycle.
    const before = fingerprintOf({ rule: "cycle", path: "/src/a/module.ts", evidence: "a -> b -> c -> a" });
    const after = fingerprintOf({ rule: "cycle", path: "/src/a/renamed.ts", evidence: "a -> b -> c -> a" });
    expect(after).toBe(before);
  });

  test("a non-cycle violation's fingerprint does include path", () => {
    const a = fingerprintOf({ rule: "public-surface-bypass", path: "/src/app/a.ts", evidence: "x" });
    const b = fingerprintOf({ rule: "public-surface-bypass", path: "/src/app/b.ts", evidence: "x" });
    expect(a).not.toBe(b);
  });

  test("a type-leak violation's fingerprint excludes the mutable 'referenced by' suffix, so one more caller of an already-known leak doesn't reopen it", () => {
    const before = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    const after = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A', 'B'",
    });
    expect(after).toBe(before);
  });

  test("a type-leak violation's fingerprint still distinguishes a genuinely different internal type", () => {
    const a = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    const b = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'OtherInternal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    expect(a).not.toBe(b);
  });

  // A module's surfaceFiles can grow from one entry to two (the same
  // step-by-step surface move this ticket is about) - checkTypeLeaks
  // anchors `path` at whichever surface file's own qualifying export site
  // sorts earliest, an accident of the new file's own line/column, not
  // part of the leak's own identity. Excluding `path` (like "cycle"
  // already does, for the same "this field is an implementation detail of
  // which one the walk picked" reason) keeps an already-frozen leak frozen
  // through that re-anchoring.
  test("a type-leak violation's fingerprint excludes path too, so a second surface file re-anchoring it doesn't un-freeze it", () => {
    const before = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    const afterSecondSurfaceReanchors = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/other-surface.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    expect(afterSecondSurfaceReanchors).toBe(before);
  });

  test("a tag-order violation's fingerprint excludes the configured sequence display, so an unrelated value added to it doesn't un-freeze an existing entry", () => {
    const before = fingerprintOf({
      rule: "tag-order",
      path: "/src/ui/widget.ts",
      evidence: "'./core.js' reaches 'layer:core' from 'layer:ui' (layer sequence: core -> ui)",
    });
    const afterUnrelatedValueAdded = fingerprintOf({
      rule: "tag-order",
      path: "/src/ui/widget.ts",
      evidence: "'./core.js' reaches 'layer:core' from 'layer:ui' (layer sequence: core -> mid -> ui)",
    });
    expect(afterUnrelatedValueAdded).toBe(before);
  });

  test("a tag-order violation's fingerprint still distinguishes a genuinely different edge", () => {
    const a = fingerprintOf({
      rule: "tag-order",
      path: "/src/ui/widget.ts",
      evidence: "'./core.js' reaches 'layer:core' from 'layer:ui' (layer sequence: core -> ui)",
    });
    const b = fingerprintOf({
      rule: "tag-order",
      path: "/src/ui/widget.ts",
      evidence: "'./other.js' reaches 'layer:core' from 'layer:ui' (layer sequence: core -> ui)",
    });
    expect(a).not.toBe(b);
  });

  test("a public-surface-bypass violation's fingerprint keys off specifier/target, not evidence's own prose, when both are present", () => {
    hegel.test(tc => {
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const specifier = tc.draw(gen.fromRegex("\\.\\./[a-z]{1,6}\\.js"));
      const target = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const evidenceA = tc.draw(gen.fromRegex("[a-z]{1,20}"));
      const evidenceB = tc.draw(gen.fromRegex("[a-z]{1,20}"));
      const base = { rule: "public-surface-bypass", path, specifier, target };

      // Changing only the explanatory text - evidence's own sentence -
      // never changes the key.
      expect(fingerprintOf({ ...base, evidence: evidenceA })).toBe(fingerprintOf({ ...base, evidence: evidenceB }));

      // Changing the importing file, the specifier, or the resolved
      // target always changes it (each compared against a genuinely
      // different draw, so the test can't pass by both draws colliding).
      const otherPath = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      tc.assume(otherPath !== path);
      expect(fingerprintOf({ ...base, path: otherPath, evidence: evidenceA }))
        .not.toBe(fingerprintOf({ ...base, evidence: evidenceA }));

      const otherSpecifier = tc.draw(gen.fromRegex("\\.\\./[a-z]{1,6}\\.js"));
      tc.assume(otherSpecifier !== specifier);
      expect(fingerprintOf({ ...base, specifier: otherSpecifier, evidence: evidenceA }))
        .not.toBe(fingerprintOf({ ...base, evidence: evidenceA }));

      const otherTarget = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      tc.assume(otherTarget !== target);
      expect(fingerprintOf({ ...base, target: otherTarget, evidence: evidenceA }))
        .not.toBe(fingerprintOf({ ...base, evidence: evidenceA }));
    }, { testCases: 30 });
  });
});

describe("findMatchingEntry's migration path for a legacy public-surface-bypass entry", () => {
  test("an entry frozen before specifier/target existed still matches the same edge, reworded evidence and all", () => {
    const path = "src/app/importer.ts";
    const oldEvidence = "'../shared/internal.js' resolved to module 'shared', which has no index.ts";
    const legacyEntry = {
      rule: "public-surface-bypass",
      path,
      evidence: oldEvidence,
      // no specifier/target: exactly what an old entry lacks.
    };
    const index = todoStore.buildTodoIndex([legacyEntry]);

    // The module gained a surface: the SAME edge now reads a different
    // sentence, and carries the structured fields every fresh violation
    // has.
    const reworded = {
      rule: "public-surface-bypass" as const,
      path: "/abs/root/src/app/importer.ts",
      evidence: "'../shared/internal.js' resolved to a file inside module 'shared' other than its index.ts",
      specifier: "../shared/internal.js",
      target: "/abs/root/src/shared/internal.ts",
    };
    const relativePath = (p: string) => p.replace("/abs/root/", "");
    expect(todoStore.findMatchingEntry(index, reworded, relativePath)).toBe(legacyEntry);

    // A genuinely different specifier at the same path must not match.
    const different = { ...reworded, specifier: "../shared/other.js" };
    expect(todoStore.findMatchingEntry(index, different, relativePath)).toBeUndefined();
  });
});

// A real project's todo files predate this fix: every entry in them was
// frozen by a HEAD whose fingerprintOf used a plain rule+path+evidence
// hash (cycle already excluded path even then), fed the SAME absolute
// path a live violation itself carries at the time (todo.ts's own freeze
// step, pre-fix, hashed straight from the live violation before
// relativizing anything for storage). buildTodoIndex must recompute a
// fresh, matching key from each such entry's own stored fields with
// today's algorithm - not trust a stored fingerprint string, which this
// shape no longer even carries - so `check` reads them as still matching
// with zero stale-todo findings, not just `todo` after a fresh prune.
describe("an old-format todo file keeps matching today's algorithm, for every rule whose formula changed", () => {
  const relativePath = (p: string) => p.replace("/root/", "");

  test("cycle: already path-excluded pre-fix too, so an old entry matches unchanged", () => {
    const evidence = "a -> b -> a";
    const entry = { rule: "cycle", path: "src/a/module.ts", evidence };
    const index = todoStore.buildTodoIndex([entry]);
    const live = { rule: "cycle", path: "/root/src/a/renamed.ts", evidence };
    expect(todoStore.findMatchingEntry(index, live, relativePath)).toBe(entry);
  });

  test("type-leak: an old entry frozen with path included (pre-fix) still matches after a second surface file re-anchors path", () => {
    const oldPath = "src/m/index.ts";
    const evidence = "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'";
    const entry = { rule: "type-leak", path: oldPath, evidence };
    const index = todoStore.buildTodoIndex([entry]);
    const live = {
      rule: "type-leak",
      path: "/root/src/m/other-surface.ts", // re-anchored to a second surface file
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A', 'B'", // one more real caller
    };
    expect(todoStore.findMatchingEntry(index, live, relativePath)).toBe(entry);
  });

  test("tag-order: an old entry frozen with the full sequence in evidence still matches after an unrelated value is inserted", () => {
    const path = "src/ui/widget.ts";
    const evidence = "'./core.js' reaches 'layer:core' from 'layer:ui' (layer sequence: core -> ui)";
    const entry = { rule: "tag-order", path, evidence };
    const index = todoStore.buildTodoIndex([entry]);
    const live = {
      rule: "tag-order",
      path: "/root/src/ui/widget.ts",
      evidence: "'./core.js' reaches 'layer:core' from 'layer:ui' (layer sequence: core -> mid -> ui)",
    };
    expect(todoStore.findMatchingEntry(index, live, relativePath)).toBe(entry);
  });
});

describe("buildTodoEntry's round trip: a freshly frozen entry always matches the live violation it came from", () => {
  const RULE_IDS = ["cycle", "type-leak", "tag-order", "tag-boundary", "point-rule", "public-surface-bypass"] as const;

  test("for every freezable rule id, findMatchingEntry(buildTodoIndex([entry]), v) recovers the entry it was built from", () => {
    hegel.test(tc => {
      const rule = tc.draw(gen.sampledFrom(RULE_IDS));
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const evidence = tc.draw(gen.fromRegex("[a-z ]{1,30}"));
      const specifier = tc.draw(gen.fromRegex("\\.\\./[a-z]{1,6}\\.js"));
      const target = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const v = rule === "public-surface-bypass"
        ? { rule, path, evidence, specifier, target }
        : { rule, path, evidence };
      const relativePath = (p: string) => p; // already relative - isolates the round trip from path normalization

      const entry = todoStore.buildTodoEntry(v, relativePath);
      const index = todoStore.buildTodoIndex([entry]);
      expect(todoStore.findMatchingEntry(index, v, relativePath)).toBe(entry);
    }, { testCases: 40 });
  });
});

describe("readTodoFile's projectRoot normalization", () => {
  test("normalizes an absolute stored path against the project root it's read with", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-normalize-"));
    try {
      const importer = join(root, "src", "app", "module.ts");
      writeTodoFile(root, new Map([["shared", [{ rule: "public-surface-bypass", path: importer, evidence: "e" }]]]));

      const parsed = readTodoFile(root)!;
      expect(parsed.modules.get("shared")).toEqual([
        { rule: "public-surface-bypass", path: "src/app/module.ts", evidence: "e" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readTodoFile's schemaVersion guard", () => {
  test("returns undefined only for the legacy { entries: [...] } shape, with no schemaVersion", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({ entries: [{ rule: "cycle", path: "src/a.ts", evidence: "e" }] }));
      expect(readTodoFile(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on a schemaVersion-less object that isn't the legacy shape either, rather than silently reading as absent", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({ modules: { shared: [] } }));
      expect(() => readTodoFile(root)).toThrow(/not a valid archstrict\.todo\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on an empty object", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), "{}");
      expect(() => readTodoFile(root)).toThrow(/not a valid archstrict\.todo\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on truncated JSON (an unresolved merge conflict, a partial write)", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), '{\n  "schemaVersion": 1,\n  "modules": {\n    "shared": [\n      {"rule":');
      expect(() => readTodoFile(root)).toThrow(/not a valid archstrict\.todo\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on an unsupported schemaVersion", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({ schemaVersion: 2, modules: {} }));
      expect(() => readTodoFile(root)).toThrow(/schemaVersion 2 is not supported/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("serializeTodoFile/parseTodoFileText round trip", () => {
  const entryGen = gen.record({
    rule: gen.sampledFrom(["cycle", "type-leak", "tag-order", "public-surface-bypass"]),
    // Quotes, backslashes, newlines, and non-ASCII: every character JSON
    // itself has to escape, plus a few it doesn't - all must survive
    // serializeTodoFile's own hand-built (not JSON.stringify(file, null,
    // 2)) wrapping unchanged.
    path: gen.fromRegex("src/[a-z]{1,4}/[a-z]{1,4}\\.ts"),
    evidence: gen.oneOf(
      gen.fromRegex("[a-z ]{1,20}"),
      gen.just("has \"quotes\" and a\nnewline"),
      gen.just("has a back\\slash"),
      gen.just("has unicode: éèê café 日本語"),
    ),
  });

  test("a shuffled module map always serializes to the same bytes, and parsing it back gives the same entries per module", () => {
    hegel.test(tc => {
      const moduleNames = [...new Set(tc.draw(gen.arrays(gen.fromRegex("[a-z]{1,6}"), { minSize: 1, maxSize: 4 })))];
      const entriesByName = new Map<string, { rule: string; path: string; evidence: string }[]>();
      for (const name of moduleNames) {
        // Duplicates allowed and expected - a real project can carry the
        // same edge frozen twice (runRules itself can report an edge more
        // than once); the writer must never silently dedupe them away.
        entriesByName.set(name, tc.draw(gen.arrays(entryGen, { minSize: 0, maxSize: 4 })));
      }

      const canonical = serializeTodoFile(entriesByName);

      // Shuffle both module order and each module's own entry order - the
      // written bytes must depend only on CONTENT, never on the Map's own
      // iteration order.
      const shuffledNames = [...moduleNames].reverse();
      const shuffled = new Map(shuffledNames.map((name) => [name, [...entriesByName.get(name)!].reverse()]));
      expect(serializeTodoFile(shuffled)).toBe(canonical);

      const parsed = parseTodoFileText("archstrict.todo.json", canonical);
      expect(parsed.schemaVersion).toBe(1);
      for (const name of moduleNames) {
        const original = [...entriesByName.get(name)!].map((e) => JSON.stringify(e)).sort();
        const roundTripped = (parsed.modules.get(name) ?? []).map((e) => JSON.stringify(e)).sort();
        expect(roundTripped).toEqual(original);
      }
    }, { testCases: 40 });
  });
});

describe("matching survives regardless of stored path format", () => {
  test("both an absolute and a relative stored path still suppress the same live violation", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-path-format-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      const config = {
        configPath: join(root, "archstrict.config.ts"),
        declaredModules: [
          { name: "app", glob: "src/app/**", surface: "index.ts" },
          { name: "shared", glob: "src/shared/**", surface: "index.ts" },
        ],
        because: "test",
      };
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
      const result = runRules(graph, config);
      expect(result.violations).toHaveLength(1);
      const violation = result.violations[0]!;

      const absoluteEntry = { rule: violation.rule, path: violation.path, evidence: violation.evidence };
      const relativeEntry = { ...absoluteEntry, path: "src/app/module.ts" };
      writeTodoFile(root, new Map([["shared", [absoluteEntry]]]));
      const withAbsolute = applyTodo(graph, config, result);
      expect(withAbsolute.todo).toBe(1);
      expect(withAbsolute.violations).toEqual([]);

      writeTodoFile(root, new Map([["shared", [relativeEntry]]]));
      const withRelative = applyTodo(graph, config, result);
      expect(withRelative.todo).toBe(1);
      expect(withRelative.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyTodo reads the todo file once per run", () => {
  // A module with N public-surface-bypass violations - the ordinary shape
  // of a fresh, un-frozen module on a large project (every one of them
  // carries the SAME target module as `todoModule`, since that field
  // names the module whose surface was bypassed, not the importer). The
  // whole project's frozen debt lives in one file now, so one real
  // readTodoFile call covers every module for the whole `applyTodo` call,
  // regardless of how many violations target it.
  test("N violations against the same module give 1 real readTodoFile call for the whole run", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-read-once-"));
    try {
      mkdirSync(join(root, "src", "target"), { recursive: true });
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "target", "index.ts"), "export const publicValue = 1;\n");
      writeFileSync(join(root, "src", "target", "internal.ts"), "export const internalValue = 1;\n");
      const N = 5;
      for (let i = 0; i < N; i++) {
        writeFileSync(
          join(root, "src", "app", `caller${i}.ts`),
          `import { internalValue } from "../target/internal.js";\nexport const v${i} = internalValue;\n`,
        );
      }
      const config = {
        configPath: join(root, "archstrict.config.ts"),
        because: "Keep modules independent.",
        declaredModules: [
          { name: "target", glob: "src/target/**", surface: "index.ts" },
          { name: "app", glob: "src/app/**" },
        ],
      };
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
      const result = runRules(graph, config);
      const bypassViolations = result.violations.filter((v) => v.rule === "public-surface-bypass");
      expect(bypassViolations).toHaveLength(N);
      expect(bypassViolations.every((v) => "todoModule" in v && v.todoModule === "target")).toBe(true);

      const spy = vi.spyOn(todoStore, "readTodoFile");
      applyTodo(graph, config, result);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a real legacy cycle stays frozen across diagnostic changes and file renames", () => {
  hegel.test(tc => {
    const renamed = `renamed${tc.draw(gen.fromRegex("[a-z]{1,12}"))}.ts`;
    const root = mkdtempSync(join(tmpdir(), "archstrict-cycle-todo-"));
    try {
      for (const name of ["a", "b"]) mkdirSync(join(root, "src", name), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
      writeFileSync(join(root, "src/a/work.ts"), 'import "../b/service.js";');
      writeFileSync(join(root, "src/b/service.ts"), 'import "../a/work.js";');
      const config = { configPath: join(root, "archstrict.config.ts"), because: "Keep modules independent.",
        declaredModules: ["a", "b"].map(name => ({ name, glob: `src/${name}/**`, surface: "*.ts" })) };
      const evaluate = () => {
        const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
        return { graph, result: runRules(graph, config) };
      };
      const before = evaluate();
      expect(before.result.violations).toHaveLength(1);
      const cycle = before.result.violations[0]!;
      const legacy = { rule: "cycle", path: cycle.path, evidence: "a -> b -> a" };
      const fingerprint = fingerprintOf(legacy);
      expect(fingerprintOf(cycle)).toBe(fingerprint);
      writeTodoFile(root, new Map([["a", [legacy]]]));
      const frozen = applyTodo(before.graph, config, before.result);
      expect(frozen.todo).toBe(1);
      expect(frozen.violations).toEqual([]);

      renameSync(join(root, "src/a/work.ts"), join(root, "src/a", renamed));
      writeFileSync(join(root, "src/b/service.ts"), `import "../a/${renamed.replace(/\.ts$/, ".js")}";`);
      const after = evaluate();
      expect(after.result.violations).toHaveLength(1);
      const renamedCycle = after.result.violations[0]!;
      expect(renamedCycle.do).toContain(`src/a/${renamed}`);
      expect(renamedCycle.do).not.toBe(cycle.do);
      expect(fingerprintOf(renamedCycle)).toBe(fingerprint);
      const stillFrozen = applyTodo(after.graph, config, after.result);
      expect(stillFrozen.todo).toBe(1);
      expect(stillFrozen.violations).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { testCases: 25 });
});
