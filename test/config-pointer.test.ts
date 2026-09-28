// The table fixes one config-pointer decision for every violation rule ID.
// String search is an independent position oracle for this authored fixture.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { Config } from "../src/config.js";
import {
  createConfigLocator,
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
      '    order: [{ tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "layer order" }],',
      '    point: [{ from: "src/a/**", to: "src/b/**", because: "no point edge" }],',
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
        order: [{ tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "layer order" }],
        point: [{ from: "src/a/**", to: "src/b/**", because: "no point edge" }],
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
      { violation: { ...base, rule: "tag-order", evidence: "'x' reaches 'layer:b' from 'layer:a' (layer sequence: a -> b)", because: "layer order" },
        expected: [{ pointer: "edges.order[0].sequence", role: "fired", marker: '{ "": ["a", "b"] }' }] },
      { violation: { ...base, rule: "point-rule", evidence: "'x' matches a forbidden edge", because: "no point edge", do: "narrow the point rule 'src/a/** -> src/b/**'" },
        expected: [{ pointer: "edges.point[0]", role: "fired", marker: '{ from: "src/a/**"' }] },
      { violation: { ...base, path: configPath, rule: "empty-rule-set", evidence: "classify glob 'src/ghost/**' matches no file in scope", because: "empty" },
        expected: [{ pointer: "classify[0]", role: "fired", marker: '{ glob: "src/ghost/**"' }] },
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
