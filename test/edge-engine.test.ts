// Responsibility: specify the edge walk's engine seam - the ARCHSTRICT_ENGINE
// parser, the refusals and their CLI shape, and that the tsrs engine walks
// and resolves every analyzed file exactly as the typescript engine does.
// Boundary: how edges become violations is every rule's own test; this file
// compares the engines' per-file answers and whole edge lists only. The
// equivalence part is skipped, with the reason as a test name, where tsrs
// has no native binary (Windows and Intel macOS).
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import ts from "typescript";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeEdgeEngine, parseEdgeEngine, TSRS_INSTALL } from "../src/edge-engine-choice.js";
import { openEdgeSession, type EdgeSession } from "../src/edge-engine.js";
import { buildModuleGraphForRules, buildPreparedGraph, prepareGraph, type DeclaredModule } from "../src/module-graph.js";
import { ReportError } from "../src/report-error.js";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(REPO, "dist/cli.js");
const FIXTURES = join(REPO, "test/fixtures");

function sessionFor(engine: string, options: ts.CompilerOptions, overlayFiles?: ReadonlyMap<string, string | null>): EdgeSession {
  const host = ts.createCompilerHost(options);
  const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const resolutionCacheFor = (opts: ts.CompilerOptions) => {
    let cache = caches.get(opts);
    if (cache === undefined) {
      cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, opts);
      caches.set(opts, cache);
    }
    return cache;
  };
  return openEdgeSession({ host, resolutionCacheFor, ...(overlayFiles ? { overlayFiles } : {}) }, { ARCHSTRICT_ENGINE: engine });
}

// Whether tsrs can parse here at all. Anything else is a reason to skip
// the equivalence tests, and that reason is shown as a test of its own.
const tsrsUnavailable: string | undefined = (() => {
  try {
    const session = sessionFor("tsrs", {});
    session.walkFile("/probe.ts", "export {};", ts.ScriptTarget.ESNext, {}, undefined);
    session.close();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
})();

describe("ARCHSTRICT_ENGINE", () => {
  test("unset, empty, and typescript select the default engine; tsrs selects tsrs", () => {
    expect(parseEdgeEngine(undefined)).toBe("typescript");
    expect(parseEdgeEngine("")).toBe("typescript");
    expect(parseEdgeEngine("typescript")).toBe("typescript");
    expect(parseEdgeEngine("tsrs")).toBe("tsrs");
  });

  test("every other value is refused with the value named and a do: that clears it", () => {
    hegel.test((tc) => {
      const value = tc.draw(gen.text({ minSize: 1, maxSize: 12 }).filter((v) => v !== "typescript" && v !== "tsrs"));
      let thrown: unknown;
      try { parseEdgeEngine(value); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(ReportError);
      const error = thrown as ReportError;
      expect(error.message).toBe(`ARCHSTRICT_ENGINE is '${value}'; the accepted values are typescript (the default) and tsrs`);
      expect(error.do).toBe("unset ARCHSTRICT_ENGINE, or set it to typescript or tsrs");
    });
  });

  test("the CLI refuses an unknown engine for every verb, as text and as --json { error, do }", () => {
    const env = { ...process.env, ARCHSTRICT_ENGINE: "TSRS" };
    const text = spawnSync("node", [CLI_PATH, "agents"], { encoding: "utf8", env, cwd: tmpdir() });
    expect(text.status).toBe(1);
    expect(text.stderr).toBe("archstrict: ARCHSTRICT_ENGINE is 'TSRS'; the accepted values are typescript (the default) and tsrs\n" +
      "do: unset ARCHSTRICT_ENGINE, or set it to typescript or tsrs\n");
    const json = spawnSync("node", [CLI_PATH, "check", "--json"], { encoding: "utf8", env, cwd: tmpdir() });
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      error: "ARCHSTRICT_ENGINE is 'TSRS'; the accepted values are typescript (the default) and tsrs",
      do: "unset ARCHSTRICT_ENGINE, or set it to typescript or tsrs",
    });
  });

  test("the default engine never loads tsrs", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-engine-default-"));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext", target: "esnext", strict: true } }));
      mkdirSync(join(root, "src/a"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"), `export default { declaredModules: [{ name: "a", glob: "src/a/**" }], exclude: ["archstrict.config.ts", "*.mjs"], because: "One module." };\n`);
      const hook = join(root, "refuse-tsrs.mjs");
      writeFileSync(hook, `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "tsrs" || specifier.startsWith("tsrs/")) throw new Error("loaded " + specifier);
  return next(specifier, context);
} });
`);
      const env = { ...process.env };
      delete env.ARCHSTRICT_ENGINE;
      const ok = spawnSync("node", ["--import", hook, CLI_PATH, "check", "--json"], { encoding: "utf8", env, cwd: root });
      expect(ok.stderr).not.toMatch(/loaded tsrs/);
      expect(ok.status).toBe(0);
      // The hook does refuse tsrs, so the pass above is not the hook missing.
      const refused = spawnSync("node", ["--import", hook, CLI_PATH, "check", "--json"], {
        encoding: "utf8", env: { ...env, ARCHSTRICT_ENGINE: "tsrs" }, cwd: root,
      });
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout).do).toBe(`${TSRS_INSTALL}, or unset ARCHSTRICT_ENGINE to use the default typescript engine`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.runIf(tsrsUnavailable !== undefined)(`tsrs equivalence is skipped on ${process.platform}-${process.arch}: ${tsrsUnavailable}`, () => {
  expect(tsrsUnavailable).toMatch(/tsrs/);
});

describe.skipIf(tsrsUnavailable !== undefined)("tsrs engine", () => {
  test("a missing native binary is refused, naming the platform and both ways out", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-engine-nobinary-"));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" } }));
      mkdirSync(join(root, "src/a"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"), `export default { declaredModules: [{ name: "a", glob: "src/a/**" }], exclude: ["archstrict.config.ts", "*.mjs"], because: "One module." };\n`);
      // TSRS_BINARY is tsrs's own override for its binary path; a path that
      // does not exist fails the same way a platform with no binary does.
      const result = spawnSync("node", [CLI_PATH, "check", "--json"], {
        encoding: "utf8", cwd: root, env: { ...process.env, ARCHSTRICT_ENGINE: "tsrs", TSRS_BINARY: join(root, "no-such-binary") },
      });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(Object.keys(report).sort()).toEqual(["do", "error"]);
      expect(report.error).toContain(`tsrs could not start its native binary on ${process.platform}-${process.arch}`);
      expect(report.error).toContain("tsrs ships binaries for linux x64 and arm64 (glibc and musl) and darwin arm64 only");
      expect(report.do).toBe(`${TSRS_INSTALL}, or unset ARCHSTRICT_ENGINE to use the default typescript engine`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a baseUrl project is refused instead of resolved with fewer edges", () => {
    const options = { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, baseUrl: "/x", configFilePath: "/x/tsconfig.json" };
    const session = sessionFor("tsrs", options);
    try {
      expect(() => session.resolve("lib/util", "/x/src/a.ts", options, undefined)).toThrow(
        "ARCHSTRICT_ENGINE=tsrs follows TypeScript 7 module resolution, which drops baseUrl lookups and the node10 and classic strategies; /x/tsconfig.json sets baseUrl, so tsrs would resolve a different graph");
    } finally {
      session.close();
    }
  });

  // Every fixture project, and this repository: each analyzed file walked
  // and each specifier resolved by both engines, compared field by field.
  const roots = [REPO, ...readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(FIXTURES, entry.name))];
  test.each(roots)("walks and resolves every analyzed file the same as typescript: %s", (root) => {
    const prepared = prepareGraph({ projectRoot: root, declaredModules: [] });
    expect(prepared.rootNames.length).toBeGreaterThan(0);
    const typescript = sessionFor("typescript", prepared.compilerOptions);
    const tsrs = sessionFor("tsrs", prepared.compilerOptions);
    try {
      for (const file of prepared.rootNames) {
        const options = prepared.compilerOptionsForFile(file);
        const format = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options);
        const text = readFileSync(file, "utf8");
        const expected = typescript.walkFile(file, text, ts.ScriptTarget.ESNext, options, format);
        expect(tsrs.walkFile(file, text, ts.ScriptTarget.ESNext, options, format), file).toEqual(expected);
        for (const imp of expected.imports) {
          if (imp.specifier.startsWith("node:")) continue;
          expect(tsrs.resolve(imp.specifier, file, options, imp.mode), `${file} ${imp.specifier}`)
            .toEqual(typescript.resolve(imp.specifier, file, options, imp.mode));
        }
      }
    } finally {
      typescript.close();
      tsrs.close();
    }
  });

  test("this repository's whole edge list is the same under both engines", () => {
    const declaredModules: DeclaredModule[] = [{ name: "src", glob: "src/**" }];
    const build = (engine: string) => {
      const previous = process.env.ARCHSTRICT_ENGINE;
      process.env.ARCHSTRICT_ENGINE = engine;
      try {
        const graph = buildPreparedGraph(prepareGraph({ projectRoot: REPO, declaredModules }));
        return { edges: graph.edges, unresolved: graph.unresolvedSpecifiers, unsupported: graph.unsupportedSyntaxCount, flags: [...graph.fileFlags] };
      } finally {
        if (previous === undefined) delete process.env.ARCHSTRICT_ENGINE; else process.env.ARCHSTRICT_ENGINE = previous;
      }
    };
    const expected = build("typescript");
    expect(expected.edges.length).toBeGreaterThan(100);
    expect(build("tsrs")).toEqual(expected);
  });

  // Small generated projects reach syntax the fixtures do not: every
  // recorded import form, resolution-mode attributes, global and ambient
  // declarations, require calls, non-ASCII text before a specifier on the
  // same line, and the three module settings whose modes differ.
  const statement = gen.sampledFrom([
    'import { a } from "./dep.js";',
    'import type { a } from "./dep.js";',
    'import { type a } from "./dep.js";',
    'import type { a } from "./dep.js" with { "resolution-mode": "require" };',
    'import type { a } from "./dep.js" with { "resolution-mode": "import" };',
    'import def, { type a } from "./dep.js";',
    'import * as ns from "./dep.js";',
    'import "./dep.js";',
    'export { a } from "./dep.js";',
    'export type { a } from "./dep.js";',
    'export * from "./dep.js";',
    'const lazy = import("./dep.js");',
    'type T = import("./dep.js").a;',
    'type U = import("./dep.js", { with: { "resolution-mode": "require" } }).a;',
    'import pkg from "pkg";',
    'import "missing-package";',
    'import fs = require("fs");',
    'const req = require("./dep.js");',
    'declare global { interface Window { x: number } }',
    'declare module "pkg" { export const y: number; }',
    'module global { export const z = 1; }',
    'namespace Local { export const w = 1; }',
    'export const value = 1;',
    'const é漢 = "/* é漢 */"; /* 漢字 */ import "./dep.js";',
  ]);
  const setting = gen.sampledFrom([
    { module: "nodenext" },
    { module: "esnext", moduleResolution: "bundler" },
    { module: "node16" },
    { module: "commonjs", moduleResolution: "bundler" },
  ]);

  test("generated projects walk and resolve the same under both engines", () => {
    hegel.test((tc) => {
      const statements = tc.draw(gen.arrays(statement, { minSize: 1, maxSize: 6 }));
      const compilerOptions = tc.draw(setting);
      const packageType = tc.draw(gen.sampledFrom(["module", "commonjs", undefined]));
      const extension = tc.draw(gen.sampledFrom([".ts", ".mts", ".cts", ".tsx"]));
      const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-engine-gen-")));
      try {
        writeFileSync(join(root, "package.json"), JSON.stringify(packageType === undefined ? {} : { type: packageType }));
        writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { ...compilerOptions, target: "esnext", jsx: "preserve" } }));
        mkdirSync(join(root, "src"), { recursive: true });
        mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
        writeFileSync(join(root, "node_modules/pkg/package.json"), JSON.stringify({ name: "pkg", version: "1.0.0",
          exports: { ".": { import: "./esm.d.ts", require: "./cjs.d.ts" } }, types: "./cjs.d.ts" }));
        writeFileSync(join(root, "node_modules/pkg/esm.d.ts"), "export declare const esm: number;\n");
        writeFileSync(join(root, "node_modules/pkg/cjs.d.ts"), "export declare const cjs: number;\n");
        writeFileSync(join(root, "src/dep.ts"), "export const a = 1;\nexport default a;\n");
        const file = join(root, `src/main${extension}`);
        writeFileSync(file, `${statements.join("\n")}\n`);
        const prepared = prepareGraph({ projectRoot: root, declaredModules: [] });
        const options = prepared.compilerOptionsForFile(file);
        const format = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options);
        const text = readFileSync(file, "utf8");
        const typescript = sessionFor("typescript", options);
        const tsrs = sessionFor("tsrs", options);
        try {
          const expected = typescript.walkFile(file, text, ts.ScriptTarget.ESNext, options, format);
          expect(tsrs.walkFile(file, text, ts.ScriptTarget.ESNext, options, format)).toEqual(expected);
          for (const imp of expected.imports) {
            expect(tsrs.resolve(imp.specifier, file, options, imp.mode), imp.specifier)
              .toEqual(typescript.resolve(imp.specifier, file, options, imp.mode));
          }
        } finally {
          typescript.close();
          tsrs.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 40 });
  });

  test("a simulated change set resolves against the in-memory files, under both engines", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-engine-overlay-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" } }));
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/gone.ts"), "export const gone = 1;\n");
      const options = prepareGraph({ projectRoot: root, declaredModules: [] }).compilerOptions;
      const overlay = new Map<string, string | null>([[join(root, "src/new/added.ts"), "export const added = 1;\n"], [join(root, "src/gone.ts"), null]]);
      const tsrs = sessionFor("tsrs", options, overlay);
      try {
        expect(tsrs.resolve("./new/added.js", join(root, "src/main.ts"), options, ts.ModuleKind.ESNext))
          .toEqual({ resolvedFile: join(root, "src/new/added.ts") });
        expect(tsrs.resolve("./gone.js", join(root, "src/main.ts"), options, ts.ModuleKind.ESNext)).toBe("unresolved");
      } finally {
        tsrs.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the edge cache keeps one engine's entries from the other's", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-engine-cache-")));
    const previous = process.env.ARCHSTRICT_ENGINE;
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" } }));
      mkdirSync(join(root, "src/a"), { recursive: true });
      mkdirSync(join(root, "src/b"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), 'import { b } from "../b/index.js";\nexport const a = b;\n');
      writeFileSync(join(root, "src/b/index.ts"), "export const b = 1;\n");
      const options = { projectRoot: root, declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }] };
      const header = () => JSON.parse(readFileSync(join(root, "node_modules/.cache/archstrict/edges.json"), "utf8")).edgeEngine;
      const edgesUnder = (engine: string) => {
        process.env.ARCHSTRICT_ENGINE = engine;
        return buildModuleGraphForRules(options).edges;
      };
      const first = edgesUnder("typescript");
      expect(header()).toBe("typescript");
      expect(edgesUnder("tsrs")).toEqual(first);
      expect(header()).toMatch(/^tsrs@/);
      expect(edgesUnder("typescript")).toEqual(first);
      expect(header()).toBe("typescript");
    } finally {
      if (previous === undefined) delete process.env.ARCHSTRICT_ENGINE; else process.env.ARCHSTRICT_ENGINE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === "linux")("a killed tsrs server is replaced once, and the walk goes on", () => {
    const options = { module: ts.ModuleKind.NodeNext };
    const session = sessionFor("tsrs", options);
    try {
      session.walkFile("/first.ts", 'import "./a.js";', ts.ScriptTarget.ESNext, options, ts.ModuleKind.ESNext);
      // Only a tsrs server this process started: a child of this process
      // whose command line runs the tsrs binary.
      const children = readdirSync(`/proc/${process.pid}/task`).flatMap((task) =>
        readFileSync(`/proc/${process.pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean));
      const servers = children.filter((pid) => existsSync(`/proc/${pid}/cmdline`) &&
        readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("tsrs"));
      expect(servers.length).toBeGreaterThan(0);
      for (const pid of servers) process.kill(Number(pid), "SIGKILL");
      execFileSync("node", ["-e", "setTimeout(() => {}, 200)"]);
      const walked = session.walkFile("/second.ts", 'import "./b.js";', ts.ScriptTarget.ESNext, options, ts.ModuleKind.ESNext);
      expect(walked.imports.map((imp) => imp.specifier)).toEqual(["./b.js"]);
    } finally {
      session.close();
      closeEdgeEngine();
    }
  });
});
