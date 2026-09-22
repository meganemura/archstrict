// Responsibility: expose architecture queries through the MCP protocol.
// Boundary: delegates rule evaluation to verbs and retains one warm graph per server.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createWarmGraph } from "./warm-graph.js";
import { check } from "./verbs/check.js";
import { rules } from "./verbs/rules.js";
import { search } from "./verbs/search.js";
import { simulate, type Change } from "./verbs/simulate.js";

const tools: Tool[] = [
  { name: "check", description: "Check project architecture, optionally focused on one file.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, additionalProperties: false } },
  { name: "rules", description: "Show the rules that govern a path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "search", description: "Search public exports by name.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "simulate", description: "Check a proposed change set in memory.",
    inputSchema: { type: "object", properties: { changes: { type: "array", items: {
      type: "object", properties: { path: { type: "string" }, content: { type: ["string", "null"] } },
      required: ["path", "content"], additionalProperties: false,
    } } }, required: ["changes"], additionalProperties: false } },
];

function stringField(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

export function createArchstrictMcpServer(projectRoot: string): Server {
  const warm = createWarmGraph();
  const server = new Server({ name: "archstrict", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const args = request.params.arguments ?? {};
      const tool = tools.find(tool => tool.name === request.params.name);
      if (tool === undefined) throw new TypeError(`Unknown tool: ${request.params.name}`);
      for (const key of Object.keys(args)) {
        if (!Object.hasOwn(tool.inputSchema.properties ?? {}, key)) throw new TypeError(`Unexpected argument: ${key}`);
      }
      let result: unknown;
      switch (request.params.name) {
        case "check":
          result = await check(projectRoot, args.file === undefined ? undefined : stringField(args, "file"), { buildGraph: warm.refresh });
          break;
        case "rules":
          result = await rules(projectRoot, stringField(args, "path"));
          break;
        case "search":
          result = await search(projectRoot, stringField(args, "query"));
          break;
        case "simulate": {
          if (!Array.isArray(args.changes)) throw new TypeError("changes must be an array");
          const changes: Change[] = args.changes.map((change: unknown) => {
            if (typeof change !== "object" || change === null || Array.isArray(change)) {
              throw new TypeError("Each change must be an object");
            }
            const entry = change as Record<string, unknown>;
            if (Object.keys(entry).some(key => key !== "path" && key !== "content")) {
              throw new TypeError("Each change must contain only path and content");
            }
            const path = stringField(entry, "path");
            if (entry.content !== null && typeof entry.content !== "string") {
              throw new TypeError("content must be a string or null");
            }
            return { path, content: entry.content };
          });
          result = await simulate(projectRoot, changes);
          break;
        }
        default:
          throw new TypeError(`Unknown tool: ${request.params.name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
