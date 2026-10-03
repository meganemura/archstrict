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
import { ReportError } from "../src/report-error.js";

const { fingerprintOf } = todoStore;

const RULE_IDS = ["cycle", "type-leak", "tag-order", "tag-boundary", "point-rule", "public-surface-bypass"] as const;

const MALFORMED = /not a valid archstrict\.todo\.json/;

const TEXTS_HOLDING_NO_OBJECT = ["", "  \n", "[]", "null", "1", "\"text\"", JSON.stringify([{ schemaVersion: 1, modules: {} }])];

// A broken todo file reaches the reader as an error plus a `do:` command,
// and both todo-file errors are fixed by regenerating the file. toThrow
// alone skips its message check when the thrown value is falsy, so the
// error is caught and checked field by field.
function expectTodoFileError(read: () => unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    read();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReportError);
  expect((thrown as ReportError).message).toMatch(message);
  expect((thrown as ReportError).do).toMatch(/archstrict todo/);
}

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

  test("evidence stays in the identity unless a public-surface-bypass violation carries both specifier and target", () => {
    hegel.test(tc => {
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const specifier = tc.draw(gen.fromRegex("\\.\\./[a-z]{1,6}\\.js"));
      const target = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const evidenceA = tc.draw(gen.fromRegex("[a-z]{1,20}"));
      const evidenceB = tc.draw(gen.fromRegex("[a-z]{1,20}"));
      tc.assume(evidenceA !== evidenceB);
      const fieldSets = [{}, { specifier }, { target }, { specifier, target }];
      for (const rule of RULE_IDS) {
        for (const fields of fieldSets) {
          if (rule === "public-surface-bypass" && "specifier" in fields && "target" in fields) continue;
          expect(fingerprintOf({ rule, path, evidence: evidenceA, ...fields }))
            .not.toBe(fingerprintOf({ rule, path, evidence: evidenceB, ...fields }));
        }
      }
    }, { testCases: 20 });
  });

  test("a type-leak violation's identity ends where its referenced-by list starts, so an entry with no list matches the same leak", () => {
    hegel.test(tc => {
      const internalType = tc.draw(gen.fromRegex("[A-Z][a-z]{1,6}"));
      const declaredIn = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const moduleName = tc.draw(gen.fromRegex("[a-z]{1,6}"));
      const exportsShown = tc.draw(gen.fromRegex("'[A-Z][a-z]{0,5}'(, '[A-Z][a-z]{0,5}'){0,2}"));
      const leak = `'${internalType}', declared in '${declaredIn}', is never exported by name from module '${moduleName}'`;
      const path = `src/${moduleName}/index.ts`;
      expect(fingerprintOf({ rule: "type-leak", path, evidence: leak }))
        .toBe(fingerprintOf({ rule: "type-leak", path, evidence: `${leak} - referenced by ${exportsShown}` }));
    }, { testCases: 20 });
  });

  test("a tag-order violation's identity is the sentence before its sequence clause, so an entry without the clause matches the same edge", () => {
    hegel.test(tc => {
      const specifier = tc.draw(gen.fromRegex("\\./[a-z]{1,6}\\.js"));
      const namespace = tc.draw(gen.fromRegex("[a-z]{1,6}"));
      const sourceLayer = tc.draw(gen.fromRegex("[a-z]{1,4}"));
      const targetLayer = tc.draw(gen.fromRegex("[a-z]{1,4}"));
      const sequence = tc.draw(gen.fromRegex("[a-z]{1,4}( -> [a-z]{1,4}){1,3}"));
      const sentence = `'${specifier}' reaches '${namespace}:${targetLayer}' from '${namespace}:${sourceLayer}'`;
      const path = "src/ui/widget.ts";
      expect(fingerprintOf({ rule: "tag-order", path, evidence: `${sentence} (${namespace} sequence: ${sequence})` }))
        .toBe(fingerprintOf({ rule: "tag-order", path, evidence: sentence }));
    }, { testCases: 20 });
  });

  test("tag-order evidence keeps all its text when the sequence marker or its preceding opening parenthesis is absent", () => {
    const evidences = [
      "(hand-written) './a.js' reaches 'layer:b'",
      "(hand-written) './a.js' reaches 'layer:c'",
      "'./a.js' reaches 'layer:b' - layer sequence: a -> b",
      "'./a.js' reaches 'layer:b' - layer sequence: a -> c",
    ];
    const fingerprints = evidences.map(evidence => fingerprintOf({ rule: "tag-order", path: "src/ui/widget.ts", evidence }));
    expect(new Set(fingerprints).size).toBe(evidences.length);
  });

  test("an evidence suffix is dropped only for the rule whose template it belongs to", () => {
    hegel.test(tc => {
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const sentence = tc.draw(gen.fromRegex("[a-z]{1,10}( [a-z]{1,10}){0,3}"));
      const sequenceA = tc.draw(gen.fromRegex("[a-z]{1,4}( -> [a-z]{1,4}){1,3}"));
      const sequenceB = tc.draw(gen.fromRegex("[a-z]{1,4}( -> [a-z]{1,4}){1,3}"));
      const shownA = tc.draw(gen.fromRegex("'[A-Z][a-z]{0,5}'"));
      const shownB = tc.draw(gen.fromRegex("'[A-Z][a-z]{0,5}'"));
      tc.assume(sequenceA !== sequenceB && shownA !== shownB);
      for (const rule of RULE_IDS) {
        if (rule !== "tag-order") {
          expect(fingerprintOf({ rule, path, evidence: `${sentence} (layer sequence: ${sequenceA})` }))
            .not.toBe(fingerprintOf({ rule, path, evidence: `${sentence} (layer sequence: ${sequenceB})` }));
        }
        if (rule !== "type-leak") {
          expect(fingerprintOf({ rule, path, evidence: `${sentence} - referenced by ${shownA}` }))
            .not.toBe(fingerprintOf({ rule, path, evidence: `${sentence} - referenced by ${shownB}` }));
        }
      }
    }, { testCases: 20 });
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

  test("a legacy entry whose evidence does not open with a quoted specifier matches no live violation", () => {
    const path = "src/app/importer.ts";
    const legacyEntry = {
      rule: "public-surface-bypass",
      path,
      evidence: "note: '../shared/internal.js' resolved to module 'shared', which has no index.ts",
    };
    const index = todoStore.buildTodoIndex([legacyEntry]);
    const relativePath = (p: string) => p;
    for (const specifier of ["../shared/internal.js", "undefined"]) {
      const live = {
        rule: "public-surface-bypass",
        path,
        evidence: `'${specifier}' resolved to module 'shared', which has no index.ts`,
        specifier,
        target: "src/shared/internal.ts",
      };
      expect(todoStore.findMatchingEntry(index, live, relativePath)).toBeUndefined();
    }
  });

  test("an entry of another rule never matches a public-surface-bypass violation, whatever its evidence says", () => {
    const path = "src/app/importer.ts";
    const specifier = "../shared/internal.js";
    const evidence = `'${specifier}' resolved to module 'shared', which has no index.ts`;
    const live = { rule: "public-surface-bypass", path, evidence, specifier, target: "src/shared/internal.ts" };
    const relativePath = (p: string) => p;
    for (const rule of RULE_IDS) {
      if (rule === "public-surface-bypass") continue;
      const index = todoStore.buildTodoIndex([{ rule, path, evidence }]);
      expect(todoStore.findMatchingEntry(index, live, relativePath)).toBeUndefined();
    }
  });

  test("an entry that stores specifier and target matches only the file it resolved to", () => {
    const path = "src/app/importer.ts";
    const specifier = "../shared/internal.js";
    const entry = {
      rule: "public-surface-bypass",
      path,
      evidence: `'${specifier}' resolved to a file inside module 'shared' other than its index.ts`,
      specifier,
      target: "src/shared/internal.ts",
    };
    const index = todoStore.buildTodoIndex([entry]);
    const relativePath = (p: string) => p;
    expect(todoStore.findMatchingEntry(index, { ...entry }, relativePath)).toBe(entry);
    expect(todoStore.findMatchingEntry(index, { ...entry, target: "src/shared/internal.tsx" }, relativePath)).toBeUndefined();
  });
});

describe("EMPTY_TODO_INDEX", () => {

  test("matches no violation, the same as an index built from no entries", () => {
    const empty = todoStore.buildTodoIndex([]);
    const relativePath = (p: string) => p;
    const specifier = "../shared/internal.js";
    const target = "src/shared/internal.ts";
    const evidence = `'${specifier}' resolved to module 'shared', which has no index.ts`;
    for (const rule of RULE_IDS) {
      for (const fields of [{}, { specifier }, { target }, { specifier, target }]) {
        const v = { rule, path: "src/app/importer.ts", evidence, ...fields };
        expect(todoStore.findMatchingEntry(todoStore.EMPTY_TODO_INDEX, v, relativePath)).toBeUndefined();
        expect(todoStore.findMatchingEntry(empty, v, relativePath)).toBeUndefined();
      }
    }
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

  test("the row it builds is the row a write and a read of the todo file give back, whatever identity fields the violation carries", () => {
    hegel.test(tc => {
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const evidence = tc.draw(gen.fromRegex("[a-z ]{1,30}"));
      const specifier = tc.draw(gen.fromRegex("\\.\\./[a-z]{1,6}\\.js"));
      const target = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const relativePath = (p: string) => p;
      for (const rule of RULE_IDS) {
        for (const fields of [{}, { specifier }, { target }, { specifier, target }]) {
          const entry = todoStore.buildTodoEntry({ rule, path, evidence, ...fields }, relativePath);
          const parsed = parseTodoFileText("archstrict.todo.json", serializeTodoFile(new Map([["m", [entry]]])));
          expect(parsed.modules.get("m")).toEqual([entry]);
        }
      }
    }, { testCases: 10 });
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

describe("parseTodoFileText", () => {

  test("a module's entries are exactly its objects whose rule, path, and evidence are text, keeping specifier and target only as a pair", () => {
    const text = {
      rule: "public-surface-bypass",
      path: "src/app/importer.ts",
      evidence: "e",
      specifier: "../shared/internal.js",
      target: "src/shared/internal.ts",
    };
    const fields = Object.keys(text) as (keyof typeof text)[];

    const kinds = [undefined, "text", 7, null] as const;
    const objects: Record<string, unknown>[] = [];
    for (let combination = 0; combination < kinds.length ** fields.length; combination++) {
      const object: Record<string, unknown> = {};
      fields.forEach((field, i) => {
        const kind = kinds[Math.floor(combination / kinds.length ** i) % kinds.length];
        if (kind === "text") object[field] = text[field];
        else if (kind !== undefined) object[field] = kind;
      });
      objects.push(object);
    }
    const plain = { rule: "public-surface-bypass", path: "src/app/importer.ts", evidence: "e" };
    const edge = {
      rule: "public-surface-bypass", path: "src/app/importer.ts", evidence: "e",
      specifier: "../shared/internal.js", target: "src/shared/internal.ts",
    };
    const expected = [
      plain, plain, plain, plain,
      plain, edge, plain, plain,
      plain, plain, plain, plain,
      plain, plain, plain, plain,
    ];

    const parsed = parseTodoFileText("archstrict.todo.json", JSON.stringify({ schemaVersion: 1, modules: { m: objects } }));
    expect(parsed.modules.get("m")).toEqual(expected);

    const optionalStates = [
      { fields: {}, expected: { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" } },
      { fields: { specifier: "./b.js" }, expected: { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" } },
      { fields: { target: "src/b.ts" }, expected: { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" } },
      {
        fields: { specifier: "./b.js", target: "src/b.ts" },
        expected: { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a", specifier: "./b.js", target: "src/b.ts" },
      },
    ];
    for (const state of optionalStates) {
      const input = { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a", ...state.fields };
      const read = parseTodoFileText("archstrict.todo.json", JSON.stringify({ schemaVersion: 1, modules: { m: [input] } }));
      expect(read.modules.get("m")).toEqual([state.expected]);
    }
  });

  test("a module value that is not an array, and an element that is not an object, record no debt beside the entries that do", () => {
    const entry = { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" };
    const notArrays = { nullValue: null, objectValue: { m: [entry] }, textValue: "text", numberValue: 3 };
    const text = JSON.stringify({
      schemaVersion: 1,
      modules: { listed: [1, "text", null, true, [entry], entry], ...notArrays },
    });

    const parsed = parseTodoFileText("archstrict.todo.json", text);
    expect(parsed.modules.get("listed")).toEqual([entry]);
    for (const name of Object.keys(notArrays)) {
      expect(parsed.modules.get(name) ?? []).toEqual([]);
    }
  });

  test("a text that holds no object reads as a malformed todo file", () => {
    for (const text of TEXTS_HOLDING_NO_OBJECT) {
      expectTodoFileError(() => parseTodoFileText("archstrict.todo.json", text), MALFORMED);
    }
  });

  test("a schemaVersion that is missing or is not a number reads as a malformed file, not an unsupported version", () => {
    const versions = [undefined, "1", null, [1], { value: 1 }];
    for (const schemaVersion of versions) {
      const text = JSON.stringify({ schemaVersion, modules: {} });
      expectTodoFileError(() => parseTodoFileText("archstrict.todo.json", text), MALFORMED);
    }
  });

  test("a top-level key other than schemaVersion and modules changes neither the version nor the entries", () => {
    const entry = { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" };
    const file = { schemaVersion: 1, modules: { m: [entry] } };

    const extras = { count: 2, notes: { other: [entry] }, comment: "text", list: [entry], flag: true, empty: null };

    const plain = parseTodoFileText("archstrict.todo.json", JSON.stringify(file));
    const withExtras = parseTodoFileText("archstrict.todo.json", JSON.stringify({ ...file, ...extras }));
    expect(withExtras.schemaVersion).toBe(plain.schemaVersion);
    expect([...withExtras.modules]).toEqual([["m", [entry]]]);
  });

  test("an absolute path or target under the given project root reads back project-relative, and as written when no root is given", () => {
    hegel.test(tc => {
      const root = join(tmpdir(), tc.draw(gen.fromRegex("[a-z]{1,8}")));
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const target = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const relativeEntry = { rule: "public-surface-bypass", path, evidence: "e", specifier: "../x.js", target };
      const absoluteEntry = { ...relativeEntry, path: join(root, path), target: join(root, target) };
      const text = JSON.stringify({ schemaVersion: 1, modules: { m: [absoluteEntry, relativeEntry] } });

      expect(parseTodoFileText("archstrict.todo.json", text, root).modules.get("m")).toEqual([relativeEntry, relativeEntry]);
      expect(parseTodoFileText("archstrict.todo.json", text).modules.get("m")).toEqual([absoluteEntry, relativeEntry]);
    }, { testCases: 10 });
  });

  test("each module key and each entry is located at its own 1-based line and column, whatever the indentation", () => {
    hegel.test(tc => {
      const indent = () => " ".repeat(tc.draw(gen.integers({ minValue: 0, maxValue: 8 })));
      const [a, b, c] = [
        { rule: "cycle", path: "src/a.ts", evidence: "a -> b -> a" },
        { rule: "cycle", path: "src/b.ts", evidence: "b -> c -> b" },
        { rule: "cycle", path: "src/c.ts", evidence: "c -> d -> c" },
      ].map((entry) => JSON.stringify(entry));
      const lines = [
        "{",
        `${indent()}"schemaVersion": 1,`,
        `${indent()}"modules": {`,
        `${indent()}"alpha": [`,
        `${indent()}${a},`,
        `${indent()}${b}`,
        `${indent()}],`,

        `${indent()}"beta": [${indent()}${c}${indent()}]`,
        `${indent()}}`,
        "}",
      ];
      const locate = (needle: string) => {
        const index = lines.findIndex((line) => line.includes(needle));
        return { line: index + 1, column: lines[index]!.indexOf(needle) + 1 };
      };

      const parsed = parseTodoFileText("archstrict.todo.json", lines.join("\n"));
      for (const name of ["alpha", "beta"]) {
        expect(parsed.moduleKeyLocation.get(name)).toEqual(locate(`"${name}"`));
      }
      const entries = [...parsed.modules.values()].flat();
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(parsed.entryLocation.get(entry)).toEqual(locate(JSON.stringify(entry)));
      }
    }, { testCases: 10 });
  });
});

describe("readTodoFile's schemaVersion guard", () => {

  test("returns undefined only for the legacy { entries: [...] } shape, with no schemaVersion", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({ entries: [{ rule: "cycle", path: "src/a.ts", evidence: "e" }] }));
      expect(readTodoFile(root)).toBeUndefined();

      const current = { rule: "cycle", path: "src/m/a.ts", evidence: "a -> b -> a" };
      const legacy = { rule: "cycle", path: "src/legacy.ts", evidence: "x -> y -> x" };
      writeFileSync(
        join(root, "archstrict.todo.json"),
        JSON.stringify({ schemaVersion: 1, entries: [legacy], modules: { m: [current] } }),
      );
      const parsed = readTodoFile(root);
      expect(parsed).toBeDefined();
      expect([...parsed!.modules]).toEqual([["m", [current]]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws a malformed-file error on a file whose text holds no object", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      for (const text of TEXTS_HOLDING_NO_OBJECT) {
        writeFileSync(join(root, "archstrict.todo.json"), text);
        expectTodoFileError(() => readTodoFile(root), MALFORMED);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on a schemaVersion-less object that isn't the legacy shape either, rather than silently reading as absent", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({ modules: { shared: [] } }));
      expectTodoFileError(() => readTodoFile(root), MALFORMED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on an empty object", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), "{}");
      expectTodoFileError(() => readTodoFile(root), MALFORMED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on truncated JSON (an unresolved merge conflict, a partial write)", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), '{\n  "schemaVersion": 1,\n  "modules": {\n    "shared": [\n      {"rule":');
      expectTodoFileError(() => readTodoFile(root), MALFORMED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on an unsupported schemaVersion", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-todo-schema-guard-"));
    try {
      writeFileSync(join(root, "archstrict.todo.json"), JSON.stringify({ schemaVersion: 2, modules: {} }));
      expectTodoFileError(() => readTodoFile(root), /schemaVersion 2 is not supported/);
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

  test("two module maps that read back as the same debt write the same bytes", () => {
    hegel.test(tc => {
      const rule = tc.draw(gen.sampledFrom(RULE_IDS));
      const path = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      const evidence = tc.draw(gen.fromRegex("[a-z ]{1,30}"));
      const specifier = tc.draw(gen.fromRegex("\\.\\./[a-z]{1,6}\\.js"));
      const target = tc.draw(gen.fromRegex("src/[a-z]{1,6}/[a-z]{1,6}\\.ts"));
      for (const fields of [{}, { specifier }, { target }, { specifier, target }]) {
        const entries = [{ rule, path, evidence, ...fields }];
        const written = serializeTodoFile(new Map([["m", entries]]));

        const readBack = parseTodoFileText("archstrict.todo.json", written).modules;
        expect(serializeTodoFile(readBack)).toBe(written);
        expect(serializeTodoFile(new Map([["a", []], ["m", entries], ["z", []]]))).toBe(written);
      }
    }, { testCases: 10 });
  });

  test("a module's entries are written in path order, then rule order, whatever order they arrive in", () => {
    hegel.test(tc => {
      const entries = tc.draw(gen.arrays(gen.record({
        rule: gen.sampledFrom(RULE_IDS),
        path: gen.fromRegex("src/[a-z]{1,3}\\.ts"),
        evidence: gen.fromRegex("[a-z ]{1,10}"),
      }), { minSize: 6, maxSize: 8 }));

      const written = parseTodoFileText("archstrict.todo.json", serializeTodoFile(new Map([["m", entries]])));
      const order = written.modules.get("m")!;
      expect(order).toHaveLength(entries.length);
      for (let i = 1; i < order.length; i++) {
        const before = order[i - 1]!;
        const after = order[i]!;
        expect(before.path < after.path || (before.path === after.path && before.rule <= after.rule)).toBe(true);
      }
    }, { testCases: 20 });
  });

  test("the written file ends in a newline, with or without debt", () => {
    const entry = { rule: "cycle", path: "src/a/x.ts", evidence: "a -> b -> a" };
    expect(serializeTodoFile(new Map())).toMatch(/\n$/);
    expect(serializeTodoFile(new Map([["m", [entry]]]))).toMatch(/\n$/);
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
