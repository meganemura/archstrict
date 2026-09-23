// Responsibility: test plugin delegation and fallback through real subprocesses.
// Boundary: use copied builds and installed dependencies in disposable consumer projects.
import { expect, test } from "vitest";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dirname, "..");
const wrapper = join(repo, "mcp/server.mjs");

function installArchstrictPackage(consumerRoot: string) {
  const installed = join(consumerRoot, "node_modules", "archstrict");
  mkdirSync(installed, { recursive: true });
  cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(repo, "package.json"), join(installed, "package.json"));
  for (const name of ["@modelcontextprotocol", "typescript"]) {
    symlinkSync(join(repo, "node_modules", name), join(consumerRoot, "node_modules", name), "dir");
  }
  writeFileSync(join(consumerRoot, "package.json"), '{"type":"module"}');
  writeFileSync(join(consumerRoot, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
  writeFileSync(join(consumerRoot, "archstrict.config.ts"), 'export default { declaredModules: [{name:"app",glob:"src/app/**"}], exclude:["*.ts"], because:"Keep public exports explicit." };');
  mkdirSync(join(consumerRoot, "src/app"), { recursive: true });
  writeFileSync(join(consumerRoot, "src/app/index.ts"), 'export const answer = 42;');
}
async function fixture(run: (root: string, other: string) => Promise<void>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-wrapper-")));
  const root = join(base, "consumer");
  const other = join(base, "other");
  mkdirSync(root); mkdirSync(other);
  try { await run(root, other); }
  finally { rmSync(base, { recursive: true, force: true }); }
}
function environment(root?: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.CLAUDE_PROJECT_DIR;
  if (root !== undefined) env.CLAUDE_PROJECT_DIR = root;
  return env;
}
async function connected(cwd: string, root: string | undefined, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: "wrapper-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [wrapper], cwd, env: environment(root), stderr: "pipe" });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); }
}
const names = ["check", "rules", "search", "simulate"];

test("the installed package supplies four tools and a real search result", () => fixture(async root => {
  installArchstrictPackage(root);
  await connected(root, root, async client => {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(names);
    const result = CallToolResultSchema.parse(await client.callTool({ name: "search", arguments: { query: "answer" } }));
    expect(result.isError).not.toBe(true);
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected a text result");
    expect(JSON.parse(block.text)).toEqual({ query: "answer", total: 1, shown: 1, matches: [
      { module: "app", surface: "src/app/index.ts", name: "answer", kind: "variable", signature: "42", score: 1 },
    ] });
  });
}));

test("the project environment takes priority over an empty working directory", () => fixture(async (root, other) => {
  installArchstrictPackage(root);
  await connected(other, root, async client => {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(names);
  });
}));

test("an absent project environment falls back to the working directory", () => fixture(async root => {
  installArchstrictPackage(root);
  await connected(root, undefined, async client => {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(names);
  });
}));

test("an empty consumer connects successfully with zero tools", () => fixture(async root => {
  await connected(root, root, async client => {
    expect(client.getServerVersion()).toEqual({ name: "archstrict", version: "0.0.0" });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.ping()).toEqual({});
  });
}));

test("the fallback ignores malformed lines and notifications and reports unknown methods", () => fixture(async root => {
  const messages = [
    "not JSON", "null", "[]",
    JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "1999-01-01" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", method: "other-notification" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown" }),
  ];
  const result = spawnSync(process.execPath, [wrapper], { cwd: root, env: environment(root), input: messages.join("\n") + "\n", encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "archstrict", version: "0.0.0" } } },
    { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    { jsonrpc: "2.0", id: "ping", result: {} },
    { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } },
  ]);
}));

const olderMcpServerSource = readFileSync(
  join(repo, "test/fixtures/vendored/mcp-server-without-startup-export.ts"),
  "utf8",
);

test("an installed older server without the startup export connects with zero tools", () => fixture(async root => {
  installArchstrictPackage(root);
  const source = olderMcpServerSource;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  writeFileSync(join(root, "node_modules/archstrict/dist/mcp-server.js"), compiled);
  await connected(root, root, async client => {
    expect(client.getServerVersion()).toEqual({ name: "archstrict", version: "0.0.0" });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.ping()).toEqual({});
  });
}));

test("an installed server that throws during import connects with zero tools", () => fixture(async root => {
  installArchstrictPackage(root);
  writeFileSync(join(root, "node_modules/archstrict/dist/mcp-server.js"), 'throw new Error("simulated broken install");');
  await connected(root, root, async client => {
    expect(client.getServerVersion()).toEqual({ name: "archstrict", version: "0.0.0" });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.ping()).toEqual({});
  });
}));
