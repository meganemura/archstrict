// Responsibility: compare MCP query results with real verbs and the built CLI.
// Boundary: real protocol transports and disposable projects, without external services.
import { beforeAll, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createArchstrictMcpServer } from "../src/mcp-server.js";
import { check } from "../src/verbs/check.js";
import { rules } from "../src/verbs/rules.js";
import { search } from "../src/verbs/search.js";
import { simulate } from "../src/verbs/simulate.js";

const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "dist/cli.js");
beforeAll(() => { execFileSync("npm", ["run", "build"], { cwd: repo }); }, 60000);

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
    { type: "object", properties: { file: { type: "string" } }, additionalProperties: false },
    { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    { type: "object", properties: { changes: { type: "array", items: {
      type: "object", properties: { path: { type: "string" }, content: { type: ["string", "null"] } },
      required: ["path", "content"], additionalProperties: false,
    } } }, required: ["changes"], additionalProperties: false },
  ]);
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
  ["check", { prove: true }, "Unexpected argument: prove"],
  ["simulate", {}, "changes must be an array"],
  ["simulate", { changes: [null] }, "Each change must be an object"],
  ["simulate", { changes: [{ path: "src/app/index.ts" }] }, "content must be a string or null"],
] as const)("%s reports invalid input %j as a tool error", (name, args, message) => project(async (_root, client) => {
  expect(await call(client, name, args)).toEqual({ isError: true, content: [{ type: "text", text: message }] });
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
