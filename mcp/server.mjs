// Responsibility: connect the consumer's installed server or an empty MCP fallback.
// Boundary: Node built-ins only; the installed package owns architecture queries.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const require = createRequire(join(root, "package.json"));
let mcpServerPath;
try { mcpServerPath = require.resolve("archstrict/dist/mcp-server.js"); }
catch { mcpServerPath = undefined; }

let imported;
if (mcpServerPath !== undefined) {
  try { imported = await import(pathToFileURL(mcpServerPath).href); }
  catch { imported = undefined; }
}
if (typeof imported?.startArchstrictMcpServer === "function") {
  await imported.startArchstrictMcpServer(root);
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message === null || typeof message !== "object" || !Object.hasOwn(message, "id")) continue;
      const { id, method } = message;
      let result;
      switch (method) {
        case "initialize":
          result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "archstrict", version: "0.0.0" } };
          break;
        case "tools/list": result = { tools: [] }; break;
        case "ping": result = {}; break;
        default:
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }) + "\n");
          continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    }
  });
}
