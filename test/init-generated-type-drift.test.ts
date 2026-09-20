// An earlier fix patched three fields (scope/classifyByDirectoryName/
// edges) that had already drifted out of init.ts's own hand-written copy
// of Config - the type a real `archstrict init` actually ships in
// archstrict.generated.ts, kept in sync by hand since a runtime
// derivation from src/config.ts isn't possible (types are erased at
// runtime, and the published package ships dist/ only). That fix patched
// the known instance; nothing stopped the NEXT top-level field from
// drifting the same way. A second drift (edges.order gaining edgeType/
// importForm without init.ts's copy) happened around the same time, but
// inside edges's own nested shape - a distinct, narrower class this file
// does not cover; see below.
//
// Two layers, so a future TOP-LEVEL Config field can't drift silently
// through either one: (1) a compile-time assertion that
// EXPECTED_GENERATED_FIELDS's own literal union still matches Config's
// real top-level keys - `tsc` fails the moment someone adds a field to
// Config here without also deciding whether it belongs in the generated
// type; (2) a runtime check that every one of those field names actually
// appears, at Config's own top-level indent, in what `archstrict init`
// really writes to disk - `tsc` alone can't make sure a maintainer who
// updated the list above also updated generatedFileContents's own
// template string, so this is what forces that second step. Neither
// layer reaches a field nested inside `edges`'s own allowDeny/order/point
// shapes - that stays a maintainer's own responsibility, same as before.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import type { Config } from "../src/config.js";

const EXPECTED_GENERATED_FIELDS = [
  "surface",
  "deprecated",
  "strict",
  "ignoredCycles",
  "because",
  "scope",
  "exclude",
  "classify",
  "classifyByDirectoryName",
  "declaredModules",
  "mustBeEmpty",
  "edges",
] as const;

// `configPath` is Config's own only top-level field NOT expected in the
// generated type - added by the loader, never by init's own template (a
// config file cannot know its own path, per init.ts's own header
// comment). Stated here so its absence from the list above reads as a
// deliberate choice, not an oversight the compile-time check missed.
type _ExpectedOmission = Exclude<keyof Config, (typeof EXPECTED_GENERATED_FIELDS)[number]>;
type _AssertOmissionIsExactlyConfigPath = [_ExpectedOmission] extends ["configPath"]
  ? ["configPath"] extends [_ExpectedOmission]
    ? true
    : ["Config has a field neither generated nor listed as the deliberate omission", _ExpectedOmission]
  : ["configPath is no longer Config's only field missing from EXPECTED_GENERATED_FIELDS", _ExpectedOmission];
const _checkOmission: _AssertOmissionIsExactlyConfigPath = true;

// The real equality check: every field on Config (other than configPath)
// must appear in EXPECTED_GENERATED_FIELDS, and vice versa - a
// mismatched name resolves this to a tuple naming which side changed and
// what the extra/missing field is, which fails to typecheck against
// `true` with that tuple's own type printed in the tsc error.
type AssertKeysMatch<Expected extends string, Actual extends string> = [Exclude<Expected, Actual>] extends [never]
  ? [Exclude<Actual, Expected>] extends [never]
    ? true
    : ["a real Config field is missing from EXPECTED_GENERATED_FIELDS above", Exclude<Actual, Expected>]
  : ["EXPECTED_GENERATED_FIELDS names a field Config no longer has", Exclude<Expected, Actual>];
const _checkFieldsMatch: AssertKeysMatch<
  (typeof EXPECTED_GENERATED_FIELDS)[number],
  Exclude<keyof Config, "configPath">
> = true;

describe("init's generated Config type stays in sync with the real Config", () => {
  test("every real Config field (other than configPath) actually appears in what a fresh archstrict init writes to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-generated-type-drift-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      const { generatedPath } = init(root);
      const generated = readFileSync(generatedPath, "utf8");

      for (const field of EXPECTED_GENERATED_FIELDS) {
        // Anchored to exactly two spaces - Config's own top-level indent in
        // the template below - not `^\s*`: a top-level field whose name
        // also recurs nested (because, surface) matched at any indent, so a
        // deleted top-level line still passed as long as a nested line of
        // the same name survived.
        expect(generated, `expected '${field}' to appear as a top-level field in the generated Config type`).toMatch(
          new RegExp(`^  ${field}\\??:`, "m"),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Referenced only for their own type-level effect (a failing assignment
// is a compile error, not a runtime one) - silence "declared but never
// read" without disabling the check itself.
void _checkOmission;
void _checkFieldsMatch;
