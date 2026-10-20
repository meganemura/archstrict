// Responsibility: compare MCP query results with real verbs and the built CLI.
// Boundary: real protocol transports and disposable projects, without external services.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createArchstrictMcpServer } from "../src/mcp-server.js";
import { ReportError } from "../src/report-error.js";
import { check, formatText, groupViolations } from "../src/verbs/check.js";
import { rules } from "../src/verbs/rules.js";
import { search } from "../src/verbs/search.js";
import { simulate } from "../src/verbs/simulate.js";

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "dist/cli.js");

function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
async function project(run: (root: string, client: Client) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-mcp-")));
  const server = createArchstrictMcpServer(root);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    put(root, "package.json", '{"type":"module"}');
    put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "nodenext", target: "esnext" } }));
    put(root, "archstrict.config.ts", `export default ${JSON.stringify({
      declaredModules: ["app", "lib"].map(name => ({ name, glob: `src/${name}/**` })),
      exclude: ["*.ts"], because: "Keep imports on the public surface.",
    })};`);
    put(root, "src/app/index.ts", 'import { answer } from "../lib/index.js";\nexport const result = answer;');
    put(root, "src/lib/index.ts", 'export { answer } from "./internal.js";');
    put(root, "src/lib/internal.ts", 'export const answer = 42;');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(root, client);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}
async function json(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected a text result");
  return JSON.parse(block.text);
}
const names = ["check", "rules", "search", "simulate"];

test("lists exactly four tools with their full input schemas", () => project(async (_root, client) => {
  const result = await client.listTools();
  expect(result.tools.map(tool => tool.name)).toEqual(names);
  expect(result.tools.map(tool => tool.inputSchema)).toEqual([
    { type: "object", properties: {
      file: { type: "string", description: "A project-relative path that limits the report to that file." },
      rule: { type: "string", description: "A rule id. The report includes only violations of that rule." },
      module: { type: "string", description: "A declared module name. The report includes only violations for that module." },
    }, additionalProperties: false },
    { type: "object", properties: { path: { type: "string", description: "A project-relative path, including a path that does not exist yet." } }, required: ["path"], additionalProperties: false },
    { type: "object", properties: { query: { type: "string", description: "The public export name to search for." } }, required: ["query"], additionalProperties: false },
    { type: "object", properties: { changes: { type: "array", description: "The proposed file changes to preview in memory.", items: {
      type: "object", properties: {
        path: { type: "string", description: "A project-relative path of the proposed file." },
        content: { type: ["string", "null"], description: "The full file text, not a patch, or null to delete the file." },
      },
      required: ["path", "content"], additionalProperties: false,
    } } }, required: ["changes"], additionalProperties: false },
  ]);
}));

test("the server reports the installed package version", () => project(async (_root, client) => {
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  expect(client.getServerVersion()).toEqual({ name: "archstrict", version: manifest.version });
}));
test("check equals the complete plain verb result", () => project(async (root, client) => {
  expect(await json(client, "check")).toEqual(await check(root, undefined, {}));
}));

test("check equals the real built CLI JSON result", () => project(async (root, client) => {
  const expected = JSON.parse(execFileSync("node", [cli, "check", "--json"], { cwd: root, encoding: "utf8" }));
  expect(await json(client, "check")).toEqual(expected);
}));

test("a second check in the same session sees a changed import", () => project(async (root, client) => {
  const before = await json(client, "check");
  expect(before.violations).toEqual([]);
  put(root, "src/app/index.ts", 'import { answer } from "../lib/internal.js";\nexport const result = answer;');
  const future = new Date(Date.now() + 2000);
  utimesSync(join(root, "src/app/index.ts"), future, future);
  const after = await json(client, "check");
  expect(after).not.toEqual(before);
  expect(after.violations.length).toBeGreaterThan(0);
  expect(after).toEqual(await check(root));
}));

test("check preserves file focus", () => project(async (root, client) => {
  put(root, "src/app/index.ts", 'import { answer } from "../lib/internal.js";\nexport const result = answer;');
  expect(await json(client, "check", { file: join(root, "src/app/index.ts") })).toEqual(await check(root, join(root, "src/app/index.ts")));
}));

test("check rule and module filters match the verb", () => project(async (root, client) => {
  put(root, "src/app/index.ts", 'import { answer } from "../lib/internal.js";\nexport const result = answer;');
  expect(await json(client, "check", { rule: "public-surface-bypass" })).toEqual(
    await check(root, undefined, { rules: ["public-surface-bypass"] }));
  expect(await json(client, "check", { module: "lib" })).toEqual(
    await check(root, undefined, { modules: ["lib"] }));
  expect(await json(client, "check", { rule: "public-surface-bypass", module: "lib" })).toEqual(
    await check(root, undefined, { rules: ["public-surface-bypass"], modules: ["lib"] }));
  const empty = await json(client, "check", { rule: "cycle", module: "app" });
  expect(empty).toEqual(await check(root, undefined, { rules: ["cycle"], modules: ["app"] }));
  expect(empty.violations).toEqual([]);
}));

test("an unknown rule or module keeps the verb's do line", () => project(async (root, client) => {
  for (const [args, options] of [
    [{ rule: "nope" }, { rules: ["nope"] }],
    [{ module: "missing" }, { modules: ["missing"] }],
  ] as const) {
    let caught: unknown;
    try {
      await check(root, undefined, options);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportError);
    const report = caught as ReportError;
    expect(report.do.startsWith("archstrict check")).toBe(true);
    expect(await call(client, "check", args)).toEqual({
      isError: true,
      content: [{ type: "text", text: `${report.message}\ndo: ${report.do}` }],
    });
  }
}));

function checkCommands(text: string): { group: string[]; omitted?: string } {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line.startsWith("modules: "));
  const details = lines.slice(0, end);
  const group = details
    .filter((line) => line.startsWith("  do: archstrict check "))
    .map((line) => line.slice("  do: ".length));
  const plain = details
    .filter((line) => line.startsWith("do: archstrict check "))
    .map((line) => line.slice("do: ".length));
  return { group, omitted: plain[0] };
}

type GroupedPayload = {
  violations: number;
  groupCount: number;
  groups: { rule: string; module: string; count: number; example: unknown; do: string }[];
  omitted: { rule: string; module: string; count: number }[];
  do?: string;
  modules: number;
};

function expectGrouped(payload: GroupedPayload, full: Awaited<ReturnType<typeof check>>) {
  expect(payload.violations).toBe(full.violations.length);
  expect(payload.violations).toBeGreaterThan(20);
  expect(Array.isArray(payload.violations)).toBe(false);
  expect(payload.modules).toBe(full.modules);
  const commands = checkCommands(formatText(full));
  const grouped = groupViolations(full.violations);
  if (grouped.length === 1) {
    expect(payload.groups.map((group) => group.do)).toEqual([commands.omitted]);
    expect(commands.group).toEqual([]);
    expect(payload.do).toBeUndefined();
    expect(payload.omitted).toEqual([]);
  } else {
    expect(payload.groups.map((group) => group.do)).toEqual(commands.group);
    expect(payload.do).toBe(commands.omitted);
  }
  expect(payload.groupCount).toBe(grouped.length);
  expect(payload.groups.length + payload.omitted.length).toBe(grouped.length);
  const shown = new Set(payload.groups.map((group) => `${group.rule}\0${group.module}`));
  expect(payload.omitted).toEqual(grouped
    .filter((group) => !shown.has(`${group.rule}\0${group.moduleName}`))
    .map((group) => ({ rule: group.rule, module: group.moduleName, count: group.violations.length })));
  for (const entry of payload.groups) {
    const match = grouped.find((group) => group.rule === entry.rule && group.moduleName === entry.module);
    expect(match).toBeDefined();
    expect(entry.count).toBe(match!.violations.length);
    expect(entry.example).toEqual(match!.violations[0]);
  }
  const counted = payload.groups.reduce((sum, group) => sum + group.count, 0)
    + payload.omitted.reduce((sum, group) => sum + group.count, 0);
  expect(counted).toBe(full.violations.length);
}

test("past 20 violations, one group returns one example and the text do", () => project(async (root, client) => {
  for (let index = 0; index < 21; index++) {
    put(root, `src/app/f${index}.ts`, 'import { answer } from "../lib/internal.js";\nexport const result = answer;\n');
  }
  const full = await check(root);
  expect(groupViolations(full.violations)).toHaveLength(1);
  expectGrouped(await json(client, "check"), full);
  expect(await json(client, "check", { rule: "cycle" })).toEqual(await check(root, undefined, { rules: ["cycle"] }));
}));

test("past 20 violations, many groups match the text report's examples and do lines", () => project(async (root, client) => {
  const names = Array.from({ length: 21 }, (_, index) => `m${String(index).padStart(2, "0")}`);
  for (const name of names) put(root, `src/${name}/secret.ts`, "export const value = 1;\n");
  const imports = names.map((name, index) => `import { value as v${index} } from "../${name}/secret.js";`).join("\n");
  const sum = names.map((_, index) => `v${index}`).join(" + ");
  put(root, "src/hub/main.ts", `${imports}\nexport const value = ${sum};\n`);
  put(root, "archstrict.config.ts", `export default ${JSON.stringify({
    declaredModules: ["hub", ...names].map((name) => ({ name, glob: `src/${name}/**` })),
    exclude: ["*.ts", "src/app/**", "src/lib/**"],
    because: "Keep imports on the public surface.",
  })};`);
  const full = await check(root);
  const payload = await json(client, "check") as GroupedPayload;
  expectGrouped(payload, full);
  expect(payload.groups.length).toBeGreaterThan(1);
  expect(payload.omitted.length).toBeGreaterThan(0);
  const narrowed = await json(client, "check", { module: names[0]! });
  expect(narrowed).toEqual(await check(root, undefined, { modules: [names[0]!] }));
  expect(Array.isArray(narrowed.violations)).toBe(true);
  expect(narrowed.violations.length).toBeLessThanOrEqual(20);
}));

test("rules equals the complete plain verb result", () => project(async (root, client) => {
  expect(await json(client, "rules", { path: join(root, "src/app/new.ts") })).toEqual(await rules(root, join(root, "src/app/new.ts")));
}));

test("search equals the complete plain verb result for a real export", () => project(async (root, client) => {
  const expected = await search(root, "answer");
  expect(expected.matches.length).toBeGreaterThan(0);
  expect(await json(client, "search", { query: "answer" })).toEqual(expected);
}));

test("simulate equals the complete plain verb result", () => project(async (root, client) => {
  const changes = [{ path: "src/app/index.ts", content: 'import { answer } from "../lib/internal.js";\nexport const result = answer;' }];
  const expected = await simulate(root, changes);
  expect(expected.added.length).toBeGreaterThan(0);
  expect(await json(client, "simulate", { changes })).toEqual(expected);
}));

test.each([
  ["rules", {}, "path must be a string"],
  ["search", { query: 42 }, "query must be a string"],
  ["check", { file: null }, "file must be a string"],
  ["check", { rule: 1 }, "rule must be a string"],
  ["check", { module: null }, "module must be a string"],
  ["check", { prove: true }, "Unexpected argument: prove"],
  ["simulate", {}, "changes must be an array"],
  ["simulate", { changes: [null] }, "Each change must be an object"],
  ["simulate", { changes: [{ path: "src/app/index.ts" }] }, "content must be a string or null"],
] as const)("%s reports invalid input %j as a tool error", (name, args, message) => project(async (_root, client) => {
  expect(await call(client, name, args)).toEqual({ isError: true, content: [{ type: "text", text: message }] });
}));

test("a schemaVersion error includes the do line", () => project(async (root, client) => {
  put(root, "archstrict.config.ts", "export default { schemaVersion: 2, declaredModules: [], because: 'test' };\n");
  const configPath = join(root, "archstrict.config.ts");
  expect(await call(client, "check")).toEqual({
    isError: true,
    content: [{
      type: "text",
      text: `${configPath} schemaVersion 2 is not supported; this archstrict reads schemaVersion 1\ndo: set schemaVersion to 1 in ${configPath}, then run archstrict check`,
    }],
  });
}));

test("a real verb error remains a tool execution error", () => project(async (root, client) => {
  const path = join(root, "..", "outside.ts");
  let message = "";
  try { await rules(root, path); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("outside project root");
  expect(await call(client, "rules", { path })).toEqual({ isError: true, content: [{ type: "text", text: message }] });
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(names);
}));

test("the built CLI serves MCP over real stdio and ignores --json", () => project(async (root) => {
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: "node", args: [cli, "mcp", "--json"], cwd: root, stderr: "pipe" });
  try {
    await client.connect(transport);
    expect(transport.pid).not.toBeNull();
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(names);
  } finally { await client.close(); }
}));

test("warm MCP checks equal cold checks after generated edit sequences", async () => {
  await hegel.testAsync(async tc => project(async (root, client) => {
    const edits = tc.draw(gen.arrays(gen.sampledFrom(["index", "internal", "none"])));
    expect(await json(client, "check")).toEqual(await check(root));
    let tick = Date.now();
    for (const target of edits) {
      const content = target === "none" ? "export const result = 0;" :
        `import { answer } from "../lib/${target}.js";\nexport const result = answer;`;
      put(root, "src/app/index.ts", content);
      const mtime = new Date(tick += 2000);
      utimesSync(join(root, "src/app/index.ts"), mtime, mtime);
      expect(await json(client, "check")).toEqual(await check(root));
    }
  }), { testCases: 20 });
}, 60000);
