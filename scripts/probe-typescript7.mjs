#!/usr/bin/env node
// Responsibility: measure, against whatever typescript 7 is installed at run
// time, which of the operations rule 6 (type leak) needs actually work on
// typescript 7.0.2's `./unstable/*` surface - `./unstable/ast` (scanner and
// AST-predicate utilities only) and `./unstable/sync` (an in-process API
// object whose Program/Checker are backed by a real child process, per
// api.d.ts's own Client/SyncRpcChannel). archstrict itself always analyzes
// with its own pinned `typescript` dependency (6.0.3, in `dependencies` -
// see AGENTS.md), independent of whichever tsc a consuming project uses;
// this script never changes that. It exists only to keep an honest,
// automatically-refreshed answer to "what would rule 6 need to change to
// also run under typescript 7" instead of a one-time, staled-out guess.
//
// Never fails: every attempted operation is wrapped in its own try/catch,
// and a typescript 7 that isn't installed at all is reported as "not run,"
// not an error. A CI job records the JSON this prints; it does not gate on
// it. Run standalone: node scripts/probe-typescript7.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every operation detectTypeLeaks (src/rules/type-leak.ts) calls on a
// TypeChecker, exercised here against a real, minimal fixture - not
// asserted structurally, since typescript 7's own internals (and which of
// these still work) are exactly what may change between releases.
function probeUnstableAst() {
  return import("typescript/unstable/ast")
    .then((ast) => {
      const hasSemanticApi = "Program" in ast || "Checker" in ast || "createProgram" in ast;
      return {
        attempted: true,
        hasSemanticApi,
        note: hasSemanticApi
          ? "unexpected: a Program/Checker export appeared here - re-check whether this surface can run rule 6 after all"
          : "confirmed: scanner and AST-predicate utilities only, no route to a type or a resolved module - rule 6 needs a Program/Checker, which this surface does not have",
      };
    })
    .catch((error) => ({ attempted: false, reason: `import failed: ${error.message}` }));
}

function probeUnstableSync() {
  return import("typescript/unstable/sync")
    .then((sync) => runSyncProbe(sync))
    .catch((error) => ({ attempted: false, reason: `import failed (typescript 7 likely not installed): ${error.message}` }));
}

// A failure setting up the fixture (parseConfigFile, updateSnapshot,
// getProject, getSourceFile) is not an import failure - conflating the two
// would report "typescript 7 likely not installed" for a real regression in
// a typescript 7 that plainly IS installed, the same "measured nothing but
// looked green" shape the CI job's own version-check step already guards
// against one layer up.
function runSyncProbe(sync) {
  const dir = mkdtempSync(join(tmpdir(), "archstrict-ts7-probe-"));
  try {
    return runSyncProbeIn(sync, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSyncProbeIn({ API }, dir) {
  const tsconfigPath = join(dir, "tsconfig.json");
  const entryPath = join(dir, "entry.ts");
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["*.ts"],
    }),
  );
  // A structural leak (Wraps -> Internal, never exported by name), an
  // inferred-return leak (makeInternal), and a real re-export
  // (InternalAlias) - the same three shapes test/type-leak.test.ts's own
  // fixture exercises locally, kept small since this runs once per CI job.
  writeFileSync(
    entryPath,
    [
      "export type Internal = { id: string };",
      "export type Wraps = { record: Internal };",
      "export function makeInternal(): Internal { return { id: \"x\" }; }",
      "export type { Internal as InternalAlias };",
    ].join("\n"),
  );

  const results = {};
  function attempt(name, fn) {
    try {
      const value = fn();
      results[name] = { status: "ok" };
      return value;
    } catch (error) {
      results[name] = { status: "error", message: error.message };
      return undefined;
    }
  }

  const api = new API();
  try {
    let checker;
    let sf;
    try {
      api.parseConfigFile(tsconfigPath);
      const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
      const project = snapshot.getProject(tsconfigPath);
      checker = project.checker;
      sf = project.program.getSourceFile(entryPath);
    } catch (error) {
      return { attempted: true, setupFailed: true, reason: error.message, supported: 0, unsupported: 0, results: {} };
    }

    const moduleSymbol = attempt("getSymbolAtLocation", () => checker.getSymbolAtLocation(sf));

    const exports = attempt("getExportsOfModule", () => checker.getExportsOfModule(moduleSymbol)) ?? [];
    const wrapsSym = exports.find((s) => s.name === "Wraps");
    const fnSym = exports.find((s) => s.name === "makeInternal");
    const aliasSym = exports.find((s) => s.name === "InternalAlias");

    const wrapsType = wrapsSym && attempt("getDeclaredTypeOfSymbol", () => checker.getDeclaredTypeOfSymbol(wrapsSym));
    const props = wrapsType && attempt("getPropertiesOfType", () => checker.getPropertiesOfType(wrapsType));
    if (wrapsType !== undefined) attempt("getIndexInfosOfType", () => checker.getIndexInfosOfType(wrapsType));

    const recordProp = props?.find((p) => p.name === "record");
    if (recordProp !== undefined) {
      attempt("getTypeOfSymbolAtLocation", () =>
        checker.getTypeOfSymbolAtLocation(recordProp, recordProp.declarations[0]),
      );
    }

    if (fnSym !== undefined) {
      const fnType = attempt("getTypeOfSymbolAtLocation(function)", () =>
        checker.getTypeOfSymbolAtLocation(fnSym, fnSym.declarations[0]),
      );
      if (fnType !== undefined) {
        attempt("getCallSignatures/getReturnTypeOfSignature", () => {
          const [sig] = fnType.getCallSignatures();
          return checker.getReturnTypeOfSignature(sig);
        });
      }
    }

    if (aliasSym !== undefined) {
      attempt("getAliasedSymbol", () => checker.getAliasedSymbol(aliasSym));
    }
  } finally {
    api.close();
  }

  const supported = Object.values(results).filter((r) => r.status === "ok").length;
  const unsupported = Object.values(results).filter((r) => r.status === "error").length;
  return { attempted: true, supported, unsupported, results };
}

async function main() {
  const summary = {
    "unstable/ast": await probeUnstableAst(),
    "unstable/sync": await probeUnstableSync(),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  // Always 0: an "unsupported" finding is the measurement this script
  // exists to take, never a reason to fail the job that ran it.
  process.exitCode = 0;
}

main();
