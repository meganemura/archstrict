// The table fixes one config-pointer decision for every violation rule ID,
// and a property fixes how a module name picks its declaredModules pointer.
// A second property fixes how a finding with no pointer of its own picks a
// list entry from its evidence, including when the list is absent. Two more
// fix how such a constraint finding picks an edge rule when rules share a
// reason or an identity, and how a tag-boundary finding picks a deny entry.
// String search is an independent position oracle for this authored fixture.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Config } from "../src/config.js";
import {
  createConfigLocator,
  declaredModulePointerForName,
  locateViolation,
  type ConfigPointer,
  type UnlocatedViolation,
} from "../src/config-pointer.js";

function positionOf(source: string, marker: string): { line: number; column: number } {
  const offset = source.indexOf(marker);
  assert.notEqual(offset, -1);
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") };
}

test("every violation rule identifies its config value, role, and source position", () => {
  const root = mkdtempSync(join(tmpdir(), "archstrict-pointer-rules-"));
  try {
    const configPath = join(root, "archstrict.config.ts");
    const source = [
      "export default {",
      '  because: "test",',
      "  declaredModules: [",
      '    { name: "a", glob: "src/a/**" },',
      '    { name: "b", glob: "src/b/**" },',
      "  ],",
      '  strict: ["a"],',
      '  ignoredCycles: [["a", "b"]],',
      '  classify: [{ glob: "src/ghost/**", tags: ["layer:ghost"] }],',
      '  mustBeEmpty: [{ glob: "src/empty/**", because: "keep empty" }],',
      '  deprecated: [{ from: "a", to: "b", count: 2, because: "remove edge" }],',
      "  edges: {",
      '    allowDeny: [{ source: "layer:a", targetNamespace: "layer", deny: ["secret"], because: "deny secret" }, { source: "layer:a", targetNamespace: "layer", allow: ["a"], because: "allow a" }],',
      '    order: [{ tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "layer order" }, { tagNamespace: "layer", within: "domain", sequence: { billing: ["a", "b"] }, direction: "downward-only", because: "billing order" }],',
      '    point: [{ from: "src/a/**", to: "src/b/**", because: "no point edge" }, { from: { tags: ["layer:a"] }, to: { tags: ["layer:secret"] }, because: "no secret edge" }],',
      "  },",
      "};",
      "",
    ].join("\n");
    writeFileSync(configPath, source);
    const config: Config = {
      configPath,
      because: "test",
      declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
      strict: ["a"],
      ignoredCycles: [["a", "b"]],
      classify: [{ glob: "src/ghost/**", tags: ["layer:ghost"] }],
      mustBeEmpty: [{ glob: "src/empty/**", because: "keep empty" }],
      deprecated: [{ from: "a", to: "b", count: 2, because: "remove edge" }],
      edges: {
        allowDeny: [
          { source: "layer:a", targetNamespace: "layer", deny: ["secret"], because: "deny secret" },
          { source: "layer:a", targetNamespace: "layer", allow: ["a"], because: "allow a" },
        ],
        order: [
          { tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "layer order" },
          { tagNamespace: "layer", within: "domain", sequence: { billing: ["a", "b"] }, direction: "downward-only", because: "billing order" },
        ],
        point: [
          { from: "src/a/**", to: "src/b/**", because: "no point edge" },
          { from: { tags: ["layer:a"] }, to: { tags: ["layer:secret"] }, because: "no secret edge" },
        ],
      },
    };
    const base = { path: "/project/source.ts", line: 1, column: 1, do: "fix it" };
    const cases: { violation: UnlocatedViolation; expected: { pointer: string; role: ConfigPointer["role"]; marker: string }[] }[] = [
      { violation: { ...base, rule: "public-surface-bypass", evidence: "bypass", because: "surface", todoModule: "b" },
        expected: [{ pointer: "declaredModules[1]", role: "governs", marker: '{ name: "b"' }] },
      { violation: { ...base, rule: "type-leak", evidence: "leak", because: "surface", todoModule: "b" },
        expected: [{ pointer: "declaredModules[1]", role: "governs", marker: '{ name: "b"' }] },
      { violation: { ...base, rule: "uncovered-module", evidence: "outside", because: "coverage" },
        expected: [{ pointer: "declaredModules", role: "governs", marker: "[\n    { name" }] },
      { violation: { ...base, rule: "cycle", evidence: "a -> b -> a", because: "cycle", todoModule: "a" },
        expected: [{ pointer: "declaredModules[0]", role: "governs", marker: '{ name: "a"' },
          { pointer: "ignoredCycles", role: "edit-here", marker: '[["a", "b"]]' }] },
      { violation: { ...base, path: configPath, rule: "stale-cycle-exception", evidence: "ignoredCycles entry ['a', 'b'] names no real cycle", because: "stale" },
        expected: [{ pointer: "ignoredCycles[0]", role: "fired", marker: '["a", "b"]' }] },
      { violation: { ...base, rule: "must-be-empty", evidence: "'src/empty/x.ts' matches 'src/empty/**', which must stay empty", because: "keep empty" },
        expected: [{ pointer: "mustBeEmpty[0]", role: "fired", marker: '{ glob: "src/empty/**"' }] },
      { violation: { ...base, path: configPath, rule: "deprecated-edge-increased", evidence: "a -> b: declared count 2, actual 3", because: "remove edge" },
        expected: [{ pointer: "deprecated[0].count", role: "fired", marker: "2, because" }] },
      { violation: { ...base, rule: "tag-boundary", evidence: "'x' (from 'layer:a') reaches 'layer:secret'", because: "deny secret" },
        expected: [{ pointer: "edges.allowDeny[0].deny[0]", role: "fired", marker: '"secret"' },
          { pointer: "edges.allowDeny[0].allow", role: "edit-here", marker: '{ source: "layer:a"' }] },
      { violation: { ...base, rule: "tag-boundary", evidence: "'x' (from 'layer:a') reaches 'layer:b'", because: "allow a" },
        expected: [{ pointer: "edges.allowDeny[1].allow", role: "fired", marker: '["a"], because: "allow a"' }] },
      { violation: { ...base, rule: "tag-order", evidence: "'x' reaches 'layer:b' from 'layer:a' (layer sequence: a -> b)", because: "layer order" },
        expected: [{ pointer: "edges.order[0].sequence", role: "fired", marker: '{ "": ["a", "b"] }' }] },
      { violation: { ...base, rule: "point-rule", evidence: "'x' matches a forbidden edge", because: "no point edge", do: "narrow the point rule 'src/a/** -> src/b/**'" },
        expected: [{ pointer: "edges.point[0]", role: "fired", marker: '{ from: "src/a/**"' }] },
      { violation: { ...base, rule: "point-rule", evidence: "'x' matches a forbidden edge", because: "no secret edge",
        do: `remove this edge, or narrow the point rule '{"tags":["layer:a"]} -> {"tags":["layer:secret"]}' in archstrict.config.ts if it's too broad` },
        expected: [{ pointer: "edges.point[1]", role: "fired", marker: "{ from: { tags" }] },
      { violation: { ...base, path: configPath, rule: "empty-rule-set", evidence: "classify glob 'src/ghost/**' matches no file in scope", because: "empty" },
        expected: [{ pointer: "classify[0]", role: "fired", marker: '{ glob: "src/ghost/**"' }] },
      { violation: { ...base, path: configPath, rule: "empty-rule-set", evidence: "order rule 'layer' matches no real edge in scope", because: "empty" },
        expected: [{ pointer: "edges.order[0]", role: "fired", marker: '{ tagNamespace: "layer", sequence' }] },
      { violation: { ...base, path: configPath, rule: "empty-rule-set", evidence: "order rule 'layer within domain' matches no real edge in scope", because: "empty" },
        expected: [{ pointer: "edges.order[1]", role: "fired", marker: '{ tagNamespace: "layer", within' }] },
      { violation: { ...base, path: configPath, rule: "exhaustive-allow-list", evidence: "allowDeny rule 'layer:a -> layer' allows every real target value", because: "allow a" },
        expected: [{ pointer: "edges.allowDeny[1].allow", role: "fired", marker: '["a"], because: "allow a"' }] },
      { violation: { ...base, rule: "clean-module-has-todo", evidence: "module 'a' is configured to stay clean", because: "clean" },
        expected: [{ pointer: "strict[0]", role: "fired", marker: '"a"]' }] },
      { violation: { ...base, rule: "stale-todo", evidence: "todo entry is stale", because: "stale" },
        expected: [{ pointer: "declaredModules", role: "governs", marker: "[\n    { name" }] },
      { violation: { ...base, path: configPath, rule: "config-meaning", evidence: "allowDeny rule (source 'layer:a'): contradiction", because: "deny secret" },
        expected: [{ pointer: "edges.allowDeny[0]", role: "fired", marker: '{ source: "layer:a"' }] },
    ];
    const locator = createConfigLocator(config);
    for (const { violation, expected } of cases) {
      const located = locateViolation(violation, config, locator);
      const pointers = Array.isArray(located.config) ? located.config : [located.config];
      assert.equal(pointers.length, expected.length, violation.rule);
      pointers.forEach((pointer, index) => {
        const wanted = expected[index]!;
        assert.equal(pointer.pointer, wanted.pointer, violation.rule);
        assert.equal(pointer.role, wanted.role, violation.rule);
        assert.deepEqual({ line: pointer.line, column: pointer.column }, positionOf(source, wanted.marker), violation.rule);
      });
      if (violation.path === configPath) {
        assert.deepEqual({ line: located.line, column: located.column },
          { line: pointers[0]!.line, column: pointers[0]!.column }, violation.rule);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module name points at its first declaredModules entry, or at the declaredModules list when no entry has that name", () => {
  hegel.test((tc) => {
    const names = tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "c"]), { maxSize: 4 }));
    const hasList = tc.draw(gs.booleans());
    const name = tc.draw(gs.sampledFrom(["a", "b", "c", "d", undefined]));
    const config: Config = { configPath: "/project/archstrict.config.ts", because: "test" };
    if (hasList) config.declaredModules = names.map((entry) => ({ name: entry, glob: `src/${entry}/**` }));
    const index = hasList && name !== undefined ? names.indexOf(name) : -1;
    assert.equal(declaredModulePointerForName(config, name), index < 0 ? "declaredModules" : `declaredModules[${index}]`);
  }, { testCases: 50 });
});

test("a finding without its own pointer names the entry its evidence quotes, or the whole list when it quotes none", () => {
  hegel.test((tc) => {
    const length = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    const hasLists = tc.draw(gs.booleans());
    const quoted = tc.draw(gs.integers({ minValue: -1, maxValue: length - 1 }));
    const indices = Array.from({ length }, (_, i) => i);
    const config: Config = { configPath: "/project/archstrict.config.ts", because: "test" };
    if (hasLists) {
      config.ignoredCycles = indices.map((i): [string, string] => [`m${i}`, `n${i}`]);
      config.mustBeEmpty = indices.map((i) => ({ glob: `src/empty${i}/**`, because: "keep empty" }));
      config.deprecated = indices.map((i) => ({ from: `m${i}`, to: `n${i}`, count: 1, because: "remove edge" }));
      config.edges = { allowDeny: indices.map((i) => ({ source: `layer:m${i}`, targetNamespace: "layer", allow: ["x"], because: `reason ${i}` })) };
    }
    const n = quoted < 0 ? 9 : quoted;
    const entry = hasLists && quoted >= 0 ? quoted : undefined;
    const base = { path: "/project/source.ts", line: 1, column: 1, do: "fix it" };
    const cases: { violation: UnlocatedViolation; pointer: string }[] = [
      { violation: { ...base, rule: "stale-cycle-exception", evidence: `ignoredCycles entry ['m${n}', 'n${n}'] names no real cycle`, because: "stale" },
        pointer: entry === undefined ? "ignoredCycles" : `ignoredCycles[${entry}]` },
      { violation: { ...base, rule: "must-be-empty", evidence: `'src/empty${n}/x.ts' matches 'src/empty${n}/**', which must stay empty`, because: "keep empty" },
        pointer: entry === undefined ? "mustBeEmpty" : `mustBeEmpty[${entry}]` },
      { violation: { ...base, rule: "deprecated-edge-increased", evidence: `m${n} -> n${n}: declared count 1, actual 2`, because: "remove edge" },
        pointer: entry === undefined ? "deprecated" : `deprecated[${entry}].count` },
      { violation: { ...base, rule: "tag-boundary", evidence: `'x' (from 'layer:m${n}') reaches 'layer:y'`, because: `reason ${n}` },
        pointer: entry === undefined ? "edges.allowDeny" : `edges.allowDeny[${entry}].allow` },
    ];
    const locator = createConfigLocator(config, "export default {};\n");
    for (const { violation, pointer } of cases) {
      const located = locateViolation(violation, config, locator);
      const pointers = Array.isArray(located.config) ? located.config : [located.config];
      assert.deepEqual(pointers.map((item) => ({ pointer: item.pointer, role: item.role })), [{ pointer, role: "fired" }], violation.rule);
    }
  }, { testCases: 50 });
});

test("a constraint finding without its own pointer names a rule that matches both its reason and its quoted identity, or the list when none does", () => {
  const ruleShape = gs.record({ reason: gs.integers({ minValue: 0, maxValue: 1 }), identity: gs.integers({ minValue: 0, maxValue: 1 }) });
  hegel.test((tc) => {
    const hasEdges = tc.draw(gs.booleans());
    const allowDeny = tc.draw(gs.arrays(ruleShape, { maxSize: 3 }));
    const order = tc.draw(gs.arrays(ruleShape, { maxSize: 3 }));
    const point = tc.draw(gs.arrays(ruleShape, { maxSize: 3 }));
    const { reason, identity } = tc.draw(gs.record({
      reason: gs.integers({ minValue: 0, maxValue: 2 }),
      identity: gs.integers({ minValue: 0, maxValue: 2 }),
    }));
    const config: Config = { configPath: "/project/archstrict.config.ts", because: "test" };
    if (hasEdges) {
      config.edges = {
        allowDeny: allowDeny.map((rule) => ({ source: `layer:m${rule.identity}`, targetNamespace: "layer", allow: ["x"], because: `reason ${rule.reason}` })),
        order: order.map((rule) => ({ tagNamespace: `m${rule.identity}`, sequence: { "": ["a", "b"] }, direction: "downward-only" as const, because: `reason ${rule.reason}` })),
        point: point.map((rule) => ({ from: `src/m${rule.identity}/**`, to: `src/n${rule.identity}/**`, because: `reason ${rule.reason}` })),
      };
    }
    const producers = (rules: readonly { reason: number; identity: number }[]): number[] => hasEdges
      ? rules.flatMap((rule, index) => rule.reason === reason && rule.identity === identity ? [index] : [])
      : [];
    const base = { path: "/project/source.ts", line: 1, column: 1, because: `reason ${reason}`, do: "fix it" };
    const cases: { violation: UnlocatedViolation; list: string; entries: string[] }[] = [
      { violation: { ...base, rule: "tag-boundary", evidence: `'x' (from 'layer:m${identity}') reaches 'layer:y'` },
        list: "edges.allowDeny", entries: producers(allowDeny).map((index) => `edges.allowDeny[${index}].allow`) },
      { violation: { ...base, rule: "tag-order", evidence: `'x' reaches 'm${identity}:b' from 'm${identity}:a' (m${identity} sequence: a -> b)` },
        list: "edges.order", entries: producers(order).map((index) => `edges.order[${index}].sequence`) },
      { violation: { ...base, rule: "point-rule", evidence: "'x' matches a forbidden edge",
        do: `remove this edge, or narrow the point rule 'src/m${identity}/** -> src/n${identity}/**' in archstrict.config.ts if it's too broad` },
        list: "edges.point", entries: producers(point).map((index) => `edges.point[${index}]`) },
    ];
    const locator = createConfigLocator(config, "export default {};\n");
    for (const { violation, list, entries } of cases) {
      const located = locateViolation(violation, config, locator);
      const pointers = Array.isArray(located.config) ? located.config : [located.config];
      assert.deepEqual(pointers.map((item) => item.role), ["fired"], violation.rule);
      const accepted = entries.length === 0 ? [list] : entries;
      assert.ok(accepted.includes(pointers[0]!.pointer), `${violation.rule}: ${pointers[0]!.pointer} is not one of ${accepted.join(", ")}`);
    }
  }, { testCases: 50 });
});

test("a tag-boundary finding without its own pointer names the deny entry it reaches, or the allow list when it reaches no denied value", () => {
  hegel.test((tc) => {
    const deny = tc.draw(gs.arrays(gs.sampledFrom(["p", "q", "r"]), { minSize: 1, maxSize: 3, unique: true }));
    const hasAllow = tc.draw(gs.booleans());
    const reached = tc.draw(gs.sampledFrom(hasAllow ? ["p", "q", "r", "z"] : deny));
    const config: Config = {
      configPath: "/project/archstrict.config.ts",
      because: "test",
      edges: { allowDeny: [{ source: "layer:a", targetNamespace: "layer", ...(hasAllow ? { allow: ["a"] } : {}), deny, because: "guard" }] },
    };
    const violation: UnlocatedViolation = { rule: "tag-boundary", path: "/project/source.ts", line: 1, column: 1,
      evidence: `'x' (from 'layer:a') reaches 'layer:${reached}'`, because: "guard", do: "fix it" };
    const located = locateViolation(violation, config, createConfigLocator(config, "export default {};\n"));
    const pointers = Array.isArray(located.config) ? located.config : [located.config];
    const expected = deny.includes(reached)
      ? [{ pointer: `edges.allowDeny[0].deny[${deny.indexOf(reached)}]`, role: "fired", value: reached },
        { pointer: "edges.allowDeny[0].allow", role: "edit-here", value: hasAllow ? ["a"] : null }]
      : [{ pointer: "edges.allowDeny[0].allow", role: "fired", value: ["a"] }];
    assert.deepEqual(pointers.map(({ pointer, role, value }) => ({ pointer, role, value })), expected);
  }, { testCases: 50 });
});

test("empty rules and stale strict findings retain the editable list when their evidence names no entry", () => {
  const config: Config = {
    configPath: "/project/archstrict.config.ts", because: "test", declaredModules: [],
    strict: ["alpha", "beta"],
    classify: [{ glob: "src/ghost/**", tags: ["layer:ghost"] }],
    deprecated: [{ from: "old", to: "new", count: 1, because: "retire" }],
    edges: {
      allowDeny: [{ source: "layer:app", targetNamespace: "layer", allow: ["ui"], because: "layers" }],
      order: [{ tagNamespace: "layer", within: "domain", sequence: {}, direction: "downward-only", because: "order" }],
      point: [{ from: { tags: ["layer:app"] }, to: "src/ui/**", because: "point" }],
    },
  };
  const base = { path: config.configPath, line: 9, column: 9, because: "unused", do: "fix" };
  const cases = [
    { rule: "empty-rule-set", evidence: "no modules declared in declaredModules", pointer: "declaredModules", value: [] },
    { rule: "empty-rule-set", evidence: "deprecated entry 'old -> new' matches no edge", pointer: "deprecated[0]", value: config.deprecated![0] },
    { rule: "empty-rule-set", evidence: "allowDeny rule 'layer:app -> layer' matches no edge", pointer: "edges.allowDeny[0]", value: config.edges!.allowDeny![0] },
    { rule: "empty-rule-set", evidence: "order rule 'layer within domain' matches no edge", pointer: "edges.order[0]", value: config.edges!.order![0] },
    { rule: "empty-rule-set", evidence: 'point rule \'{"tags":["layer:app"]} -> src/ui/**\' matches no edge', pointer: "edges.point[0]", value: config.edges!.point![0] },
    { rule: "empty-rule-set", evidence: "unrecognized empty rule", pointer: "edges", value: config.edges },
    { rule: "clean-module-has-todo", evidence: "module 'beta' has debt", pointer: "strict[1]", value: "beta" },
    { rule: "clean-module-has-todo", evidence: "module 'removed' has debt", pointer: "strict", value: ["alpha", "beta"] },
  ];
  for (const { rule, evidence, pointer, value } of cases) {
    const located = locateViolation({ ...base, rule, evidence }, config, createConfigLocator(config, "export default {};"));
    assert.deepEqual(located.config, { path: config.configPath, pointer, value, role: "fired", line: 1, column: 16 });
    assert.deepEqual({ line: located.line, column: located.column }, { line: 1, column: 16 });
  }
  const absent: Config = { configPath: config.configPath, because: "test" };
  for (const { rule, pointer, role } of [
    { rule: "empty-rule-set", pointer: "edges", role: "fired" },
    { rule: "clean-module-has-todo", pointer: "strict", role: "fired" },
    { rule: "exhaustive-allow-list", pointer: "edges.allowDeny", role: "fired" },
    { rule: "config-meaning", pointer: "edges", role: "governs" },
    { rule: "future-rule", pointer: "declaredModules", role: "governs" },
  ]) {
    const located = locateViolation({ ...base, rule, evidence: "unknown" }, absent, createConfigLocator(absent, "export default {};"));
    assert.deepEqual(located.config, { path: config.configPath, pointer, value: null, role, line: 1, column: 16 });
  }
});

test("config meaning findings select their rule kind and reason independently of entry order", () => {
  hegel.test((tc) => {
    const reverse = tc.draw(gs.booleans());
    const selectedKind = tc.draw(gs.sampledFrom<keyof NonNullable<Config["edges"]>>(["allowDeny", "order", "point"]));
    const selectedReason = tc.draw(gs.sampledFrom(["first", "second", "missing"]));
    const reasons = reverse ? ["second", "first"] : ["first", "second"];
    const config: Config = {
      configPath: "/project/archstrict.config.ts", because: "test",
      edges: {
        allowDeny: reasons.map(because => ({ source: "layer:a", targetNamespace: "layer", allow: ["b"], because })),
        order: reasons.map(because => ({ tagNamespace: "layer", sequence: {}, direction: "downward-only", because })),
        point: reasons.map(because => ({ from: "src/a/**", to: "src/b/**", because })),
      },
    };
    const selectedIndex = selectedReason === "missing" ? undefined : reverse === (selectedReason === "second") ? 0 : 1;
    const violation = { rule: "config-meaning", path: "/source.ts", line: 7, column: 3,
      because: selectedReason, evidence: `${selectedKind} rule (invalid restriction)`, do: "fix" };
    const located = locateViolation(violation, config, createConfigLocator(config, "export default {};"));
    const expected = selectedIndex === undefined
      ? { pointer: "edges", value: config.edges, role: "governs" }
      : { pointer: `edges.${selectedKind}[${selectedIndex}]`, value: config.edges![selectedKind]![selectedIndex], role: "fired" };
    assert.deepEqual(located.config, { path: config.configPath, ...expected, line: 1, column: 16 });
    assert.deepEqual({ line: located.line, column: located.column }, { line: 7, column: 3 });
  }, { testCases: 50 });
});

test("an exhaustive allow finding distinguishes matching identities at the first entry from unmatched evidence", () => {
  const config: Config = { configPath: "/project/archstrict.config.ts", because: "test", edges: { allowDeny: [
    { source: "layer:app", targetNamespace: "layer", allow: ["ui"], because: "layers" },
    { source: "layer:other", targetNamespace: "layer", allow: ["ui"], because: "layers" },
  ] } };
  for (const { evidence, pointer, value } of [
    { evidence: "allowDeny rule 'layer:app -> layer' allows every value", pointer: "edges.allowDeny[0].allow", value: ["ui"] },
    { evidence: "allowDeny rule 'layer:removed -> layer' allows every value", pointer: "edges.allowDeny", value: config.edges!.allowDeny },
  ]) {
    const located = locateViolation({ rule: "exhaustive-allow-list", path: "/source.ts", line: 1, column: 1,
      evidence, because: "layers", do: "restrict" }, config, createConfigLocator(config, "export default {};"));
    assert.deepEqual(located.config, { path: config.configPath, pointer, value, role: "fired", line: 1, column: 16 });
  }
});
