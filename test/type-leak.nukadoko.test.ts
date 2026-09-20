// Verifies the promoted rule against the same real target the spike it was
// promoted from measured: nukadoko's own published src/index.ts (its own
// public entry point already, read-only - node_modules/nukadoko/src, not a
// live checkout, for the same reason the nukadoko dogfood scenario uses it).
// This is not a per-module archstrict check (index.ts sits directly under
// src/, outside any module directory, so archstrict's own module glob would
// never reach it) - it exercises detectTypeLeaks directly, the same core
// function checkTypeLeaks calls per module.
//
// The spike this rule was promoted from reported 0 leaks here. That number
// was itself a symptom of the same bug review caught in this rule's own
// first draft (this file's own git history has the fix): neither ever
// resolved a re-exported symbol (`export type { Foo } from "./x.js"`)
// through its alias to the real declaration, so every one of nukadoko's
// index.ts exports - which are ALL re-exports, none a local declaration -
// silently fell through unchecked. "0 leaks" measured nothing, not
// nothing-leaked. Reported as a real finding (headquarters-issues, tool:
// nukadoko) rather than adjusted away.
import { describe, expect, test } from "vitest";
import ts from "typescript";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectTypeLeaks } from "../src/rules/type-leak.js";

const NUKADOKO_SRC = fileURLToPath(new URL("../node_modules/nukadoko/src", import.meta.url));

// The published npm package ships no tsconfig.json (only source, per its
// own README) - reading one from node_modules/nukadoko would silently fail
// (ts.readConfigFile swallows the ENOENT into a returned `error`, not a
// thrown one) and fall back to options with no module/moduleResolution
// set, under which every `./x.js`-style relative import in this package's
// own real source fails to resolve to its `.ts` file. These options match
// nukadoko's own real tsconfig.json (its `module`/`moduleResolution`,
// the two settings resolution actually depends on).
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
};

describe("detectTypeLeaks against nukadoko's real src/index.ts", () => {
  test("finds real structural leaks - measured, not assumed to be 0", () => {
    const entry = join(NUKADOKO_SRC, "index.ts");
    const program = ts.createProgram({ rootNames: [entry], options: OPTIONS });
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(entry);
    if (sf === undefined) throw new Error(`could not load ${entry}`);

    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) throw new Error(`${entry} has no module symbol`);
    const exports = checker.getExportsOfModule(moduleSymbol);

    // Anti-vacuity: resolve one known re-export (defineStep, a function)
    // all the way through and confirm it has real call signatures. If
    // module resolution were silently broken (the wrong options, a
    // missing file), every export would fail to resolve to a real
    // declaration - the exact way the spike's own "0 leaks" turned out to
    // mean nothing was checked, not nothing leaked.
    const defineStep = exports.find((s) => s.name === "defineStep");
    if (defineStep === undefined) throw new Error("expected 'defineStep' among the resolved exports");
    const defineStepDecl = defineStep.getDeclarations()?.[0];
    if (defineStepDecl === undefined) throw new Error("'defineStep' resolved to no declaration - module resolution is broken");
    const defineStepType = checker.getTypeOfSymbolAtLocation(defineStep, defineStepDecl);
    expect(defineStepType.getCallSignatures().length).toBeGreaterThan(0);

    const leaks = detectTypeLeaks(checker, sf, NUKADOKO_SRC);

    expect(exports.length).toBeGreaterThan(0);
    // A known, hand-verified real leak: StepRecordOk's own shape
    // (re-exported by name from index.ts) references ObservedCounts,
    // an interface declared in context/observed.ts and never itself
    // exported by name from index.ts. Pinning one finding by name, not
    // just a nonzero count, means a future change to this detector that
    // silently stopped finding real leaks (the same failure mode as the
    // bug this test itself was written to catch) would fail loudly here.
    expect(leaks.some((l) => l.exportedAs === "StepRecordOk" && l.internalType === "ObservedCounts")).toBe(true);
    expect(leaks.length).toBeGreaterThan(0);
  });
});
