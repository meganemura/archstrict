// Responsibility: verify public export search through real compiler graphs and the built CLI.
// Boundary: disposable fixture projects; generated assertions cover names, scores, order, and limits.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import ts from "typescript";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { search, tokenize, formatSearchText, type SearchResult } from "../src/verbs/search.js";
import { buildPreparedGraph, prepareGraph } from "../src/module-graph.js";

function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
async function project(run: (root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-search-")));
  try {
    put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "nodenext", target: "esnext" } }));
    put(root, "package.json", '{"type":"module"}');
    configure(root);
    put(root, "src/alpha/index.ts", 'export function parseConfig(text: string): number { return 1; }\nexport const configVersion = 1;');
    put(root, "src/beta/index.ts", 'export interface Config { value: string }\nexport const unrelated = 2;');
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function configure(root: string, extra: object = {}) {
  put(root, "archstrict.config.ts", `export default ${JSON.stringify({
    declaredModules: ["beta", "alpha"].map(name => ({ name, glob: `src/${name}/**` })),
    exclude: ["*.ts"], because: "Keep public capabilities explicit.", ...extra,
  })};`);
}
const expected: SearchResult = { query: "parse config", total: 3, shown: 3, matches: [
  { module: "alpha", surface: "src/alpha/index.ts", name: "parseConfig", kind: "function", signature: "(text: string) => number", score: 1 },
  { module: "alpha", surface: "src/alpha/index.ts", name: "configVersion", kind: "variable", signature: "1", score: 0.5 },
  { module: "beta", surface: "src/beta/index.ts", name: "Config", kind: "interface", signature: "Config", score: 0.5 },
] };
const expectedText = '3 matches for "parse config" (showing 3)\n' +
  'alpha :: parseConfig (function) - (text: string) => number  [score 1.00]\n' +
  'alpha :: configVersion (variable) - 1  [score 0.50]\n' +
  'beta :: Config (interface) - Config  [score 0.50]\n';

test("tokenizer splits acronyms, case transitions, digits, and punctuation exactly", () => {
  expect(tokenize("parseJSONConfig")).toEqual(["parse", "json", "config"]);
  expect(tokenize("ABc aB foo_bar--HTTPServer v2JSON café 日本語")).toEqual(["a", "bc", "a", "b", "foo", "bar", "http", "server", "v2json", "caf"]);
  expect(tokenize("***")).toEqual([]);
});

test("exact JSON shape ranks public names and exposes only surface paths", () => project(async root => {
  put(root, "src/alpha/internal.ts", "export const configSecret = 1;");
  expect(await search(root, "parse config")).toEqual(expected);
  expect(await search(root, "secret")).toEqual({ query: "secret", total: 0, shown: 0, matches: [] });
}));

test("exact text output includes a count and formatted scores", () => project(async root => {
  expect(formatSearchText(await search(root, "parse config"))).toBe(expectedText);
  expect(formatSearchText(await search(root, "zzzz"))).toBe('0 matches for "zzzz" (showing 0)\n');
}));

for (const wildcard of [false, true]) {
  test(`${wildcard ? "wildcard" : "named alias"} re-exports retain their real kinds and signatures`, () => project(async root => {
    const declarations = 'export function apiFunction(value: number): number { return value; }\n' +
      'export class ApiClass {}\nexport interface ApiInterface { value: number }\n' +
      'export const apiConst = 1;\nexport let apiLet = 2;\nexport var apiVar = 3;\n' +
      'export type ApiType = string;\nexport enum ApiEnum { First, Second }\nexport namespace ApiNamespace { export const value = 1; }';
    put(root, "src/alpha/internal.ts", declarations);
    const names = ["apiFunction", "ApiClass", "ApiInterface", "apiConst", "apiLet", "apiVar", "ApiType", "ApiEnum", "ApiNamespace"];
    put(root, "src/alpha/index.ts", wildcard ? 'export * from "./internal.js";' : `export { ${names.join(", ")} } from "./internal.js";`);
    const graph = buildPreparedGraph(prepareGraph({ projectRoot: root, declaredModules: [{ name: "alpha", glob: "src/alpha/**" }], exclude: ["*.ts"] }));
    const sf = graph.program.getSourceFile(join(root, "src/alpha/index.ts"))!;
    const symbols = graph.checker.getExportsOfModule(graph.checker.getSymbolAtLocation(sf)!);
    expect(symbols.every(symbol => Boolean(symbol.flags & ts.SymbolFlags.Alias) === !wildcard)).toBe(true);
    const variable = symbols.find(symbol => symbol.name === "apiConst")!;
    const target = wildcard ? variable : graph.checker.getAliasedSymbol(variable);
    expect(Boolean(target.flags & ts.SymbolFlags.Variable)).toBe(true);
    const result = await search(root, "api");
    expect(result.total).toBe(9);
    expect(Object.fromEntries(result.matches.map(match => [match.name, [match.kind, match.signature]]))).toEqual({
      apiFunction: ["function", "(value: number) => number"], ApiClass: ["class", "typeof ApiClass"],
      ApiInterface: ["interface", "ApiInterface"], apiConst: ["variable", "1"], apiLet: ["variable", "number"], apiVar: ["variable", "number"],
      ApiType: ["type-alias", "string"], ApiEnum: ["enum", "ApiEnum"], ApiNamespace: ["namespace", ""],
    });
    expect(result.matches.every(match => match.surface === "src/alpha/index.ts")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("internal");
  }));
}

test("renamed and unresolved aliases use public names without throwing", () => project(async root => {
  put(root, "src/alpha/internal.ts", "export function secretImplementation(): number { return 1; }");
  put(root, "src/alpha/index.ts", 'export { secretImplementation as publicCapability } from "./internal.js";\nexport { missingCapability } from "./absent.js";');
  const result = await search(root, "capability");
  expect(result.matches.map(({ name, kind, signature }) => ({ name, kind, signature }))).toEqual([
    { name: "missingCapability", kind: "other", signature: "" },
    { name: "publicCapability", kind: "function", signature: "() => number" },
  ]);
  expect((await search(root, "secret")).total).toBe(0);
}));

test("multiple surface globs contribute entries from both public files", () => project(async root => {
  configure(root, { declaredModules: [{ name: "alpha", glob: "src/alpha/**", surface: ["entry/*.ts", "types/*.d.ts"] }] });
  put(root, "src/alpha/entry/main.ts", "export const publicValue = 1;");
  put(root, "src/alpha/types/main.d.ts", "export interface PublicShape { value: number }");
  const result = await search(root, "public");
  expect(result.total).toBe(2);
  expect(result.matches.map(match => match.surface).sort()).toEqual(["src/alpha/entry/main.ts", "src/alpha/types/main.d.ts"]);
}));

test("missing surfaces and script surfaces contribute zero exports", () => project(async root => {
  rmSync(join(root, "src/alpha/index.ts"));
  put(root, "src/alpha/internal.ts", "export const publicValue = 1;");
  put(root, "src/beta/index.ts", "const publicValue = 2;");
  expect(await search(root, "public")).toEqual({ query: "public", total: 0, shown: 0, matches: [] });
}));

test("substring scoring counts each query token once and ignores signatures", () => project(async root => {
  put(root, "src/alpha/index.ts", "export function parseParser(): string { return ''; }");
  put(root, "src/beta/index.ts", "export const elsewhere = 1;");
  expect((await search(root, "pars parser missing")).matches[0]!.score).toBe(2 / 3);
  expect((await search(root, "parse parse missing")).matches[0]!.score).toBe(2 / 3);
  expect((await search(root, "parsers")).matches[0]!.score).toBe(1);
  expect((await search(root, "string")).total).toBe(0);
}));

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, "search", ...args], { cwd: root, encoding: "utf8" });
}
test("built CLI joins query arguments and prints exact JSON and text with exit zero", () => project(async root => {
  const json = cli(root, "parse", "--json", "config");
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual(expected);
  const text = cli(root, "parse", "config");
  expect(text.status).toBe(0);
  expect(text.stdout).toBe(expectedText);
  for (const args of [["zzzz"], ["zzzz", "--json"]]) {
    const result = cli(root, ...args);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(args.includes("--json") ? JSON.stringify({ query: "zzzz", total: 0, shown: 0, matches: [] }, null, 2) + "\n" : '0 matches for "zzzz" (showing 0)\n');
  }
}));

test("empty queries fail through the API and normal CLI error formats", () => project(async root => {
  for (const query of ["", "***"]) {
    await expect(search(root, query)).rejects.toThrow("query must contain at least one word");
    const json = cli(root, query, "--json");
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ error: "archstrict search: query must contain at least one word", next: "archstrict search" });
  }
  const text = cli(root);
  expect(text.status).toBe(1);
  expect(text.stderr).toContain("query must contain at least one word");
  put(root, "archstrict.config.ts", "export default {};");
  expect(JSON.parse(cli(root, "parse", "--json").stdout).error).toContain("declaredModules");
}));

test("arbitrary strings produce only nonempty lowercase alphanumeric tokens", () => {
  let cases = 0;
  hegel.test(tc => {
    const text = tc.draw(gen.text());
    const tokens = tokenize(text);
    for (const token of tokens) expect(token).toMatch(/^[a-z0-9]+$/);
    expect(tokens.join("")).toBe(text.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase());
    cases++;
  }, { testCases: 1000 });
  console.log(JSON.stringify({ property: "tokens", cases }));
});

test("generated queries have bounded scores and match the token-overlap oracle", async () => {
  let cases = 0;
  await hegel.testAsync(async tc => project(async root => {
    const queryTokens = ["parse", ...tc.draw(gen.arrays(gen.sampledFrom(["config", "configuration", "parse", "version", "zzzz"])) )];
    const result = await search(root, queryTokens.join(" "));
    const names: Record<string, string[]> = { parseConfig: ["parse", "config"], configVersion: ["config", "version"], Config: ["config"], unrelated: ["unrelated"] };
    const oracle = Object.entries(names).map(([name, words]) => ({ name,
      score: queryTokens.reduce((count, word) => count + Number(words.some(other => word.includes(other) || other.includes(word))), 0) / queryTokens.length,
    })).filter(match => match.score > 0);
    expect(result.total).toBe(oracle.length);
    for (const match of result.matches) {
      expect(match.score).toBeGreaterThan(0);
      expect(match.score).toBeLessThanOrEqual(1);
      expect(match.score).toBe(oracle.find(entry => entry.name === match.name)!.score);
    }
    cases++;
  }), { testCases: 25 });
  console.log(JSON.stringify({ property: "scores", cases }));
});

test("an indexed export's own tokenized name returns score one", async () => {
  let cases = 0;
  await hegel.testAsync(async tc => project(async root => {
    const words = tc.draw(gen.arrays(gen.sampledFrom(["parse", "json", "config", "load", "value"]), { minSize: 1 }));
    const name = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join("");
    put(root, "src/alpha/index.ts", `export const ${name} = 1;`);
    const result = await search(root, words.join(" "));
    expect(result.matches.find(match => match.module === "alpha" && match.name === name)?.score).toBe(1);
    cases++;
  }), { testCases: 25 });
  console.log(JSON.stringify({ property: "exact-name", cases }));
});

test("real multi-module results obey score and name ordering", async () => {
  let cases = 0;
  await hegel.testAsync(async tc => project(async root => {
    const modules = tc.draw(gen.arrays(gen.sampledFrom(["zeta", "alpha", "beta"]), { minSize: 3, maxSize: 3, unique: true }));
    configure(root, { declaredModules: modules.map(name => ({ name, glob: `src/${name}/**` })) });
    for (const module of modules) {
      const names = tc.draw(gen.arrays(gen.sampledFrom(["parseConfig", "parseValue", "configValue"]), { minSize: 3, maxSize: 3, unique: true }));
      put(root, `src/${module}/index.ts`, names.map(name => `export const ${name} = 1;`).join("\n"));
    }
    const query = tc.draw(gen.sampledFrom(["parse config", "value parse", "config", "parse value config"]));
    const result = await search(root, query);
    expect(result.matches.length).toBeGreaterThan(1);
    for (let i = 1; i < result.matches.length; i++) {
      const before = result.matches[i - 1]!, after = result.matches[i]!;
      expect(before.score).toBeGreaterThanOrEqual(after.score);
      if (before.score === after.score) {
        expect(before.module <= after.module).toBe(true);
        if (before.module === after.module) expect(before.name <= after.name).toBe(true);
      }
    }
    cases++;
  }), { testCases: 25 });
  console.log(JSON.stringify({ property: "ordering", cases }));
});

test("shown equals the capped real total across generated export counts", async () => {
  let cases = 0, capped = 0;
  await hegel.testAsync(async tc => project(async root => {
    const count = tc.draw(gen.integers({ minValue: 0, maxValue: 60 }));
    const value = tc.draw(gen.integers());
    put(root, "src/alpha/index.ts", Array.from({ length: count }, (_, i) => `export const capability${i} = ${value};`).join("\n") + "\nexport {};");
    const result = await search(root, "capability");
    expect(result.total).toBe(count);
    expect(result.shown).toBe(Math.min(20, result.total));
    expect(result.matches).toHaveLength(result.shown);
    cases++; if (count > 20) capped++;
  }), { testCases: 40 });
  expect(cases).toBeGreaterThanOrEqual(40);
  expect(capped).toBeGreaterThan(0);
  console.log(JSON.stringify({ cases, capped }));
});

test("a re-exported module-valued const replaces its internal import signature", () => project(async root => {
  put(root, "src/alpha/internal.ts", 'import * as otherModule from "./internal.js";\nexport const publicNs = otherModule;\nexport const value = 1;');
  put(root, "src/alpha/index.ts", 'export { publicNs } from "./internal.js";');
  const result = await search(root, "public ns");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]!.kind).toBe("variable");
  expect(result.matches[0]!.signature).toBe('typeof import("<module>")');
  expect(result.matches[0]!.signature).not.toContain(root);
  expect(result.matches[0]!.signature).not.toContain("internal");
}));

test("a namespace re-export replaces its internal import signature", () => project(async root => {
  put(root, "src/alpha/internal.ts", "export const value = 1;");
  put(root, "src/alpha/index.ts", 'export * as publicNs from "./internal.js";');
  const result = await search(root, "public ns");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]!.kind).toBe("namespace");
  expect(result.matches[0]!.signature).toBe('typeof import("<module>")');
  expect(result.matches[0]!.signature).not.toContain(root);
  expect(result.matches[0]!.signature).not.toContain("internal");
}));

test("every public match keeps internal paths out of signature, surface, and module fields", async () => {
  let cases = 0;
  await hegel.testAsync(async tc => project(async root => {
    const value = tc.draw(gen.integers());
    for (const module of ["alpha", "beta"]) {
      put(root, `src/${module}/internal.ts`, 'import * as ownModule from "./internal.js";\n' +
        `export const publicValue = ${value};\nexport const publicNs = ownModule;\n` +
        'export function publicFactory() { return { ns: ownModule }; }\n' +
        'export class PublicClass {}\nexport interface PublicInterface { value: number }\n' +
        'export type PublicType = number;\nexport enum PublicEnum { One }');
      put(root, `src/${module}/index.ts`, 'export { publicValue, publicNs, publicFactory, PublicClass, PublicInterface, PublicType, PublicEnum } from "./internal.js";\n' +
        'export * as publicModule from "./internal.js";');
    }
    const result = await search(root, "public");
    expect(result.total).toBe(16);
    expect(result.shown).toBe(result.total);
    for (const match of result.matches) {
      for (const field of [match.signature, match.surface, match.module]) {
        expect(field).not.toContain(root);
        expect(field).not.toContain("internal");
      }
      if (match.name === "publicFactory") {
        expect(match.kind).toBe("function");
        expect(match.signature).toContain('ns: typeof import("<module>")');
      }
    }
    cases++;
  }), { testCases: 20 });
  console.log(JSON.stringify({ property: "public-paths", cases }));
});
