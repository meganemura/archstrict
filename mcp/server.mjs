// Responsibility: connect the consumer's installed server or an empty MCP fallback.
// Boundary: Node built-ins only; the installed package owns architecture queries.
// Plugin distribution supplies files without its own npm installation, so npm packages
// such as the SDK may not resolve here. Use built-ins until delegation reaches
// the consuming project's installed archstrict package, where its SDK dependency resolves.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// Observations across many live Claude Code MCP processes consistently found both cwd
// and CLAUDE_PROJECT_DIR set to the session's project root. Prefer the explicit
// environment signal over a potentially inherited cwd; retain cwd as the fallback.
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const require = createRequire(join(root, "package.json"));
let mcpServerPath;
// createRequire anchors Node's synchronous resolution to the consumer. Its clean failure
// detects absence while respecting node_modules layouts, symlinks, and workspaces.
// An existsSync check on a guessed path would not follow those resolution rules.
try { mcpServerPath = require.resolve("archstrict/dist/mcp-server.js"); }
catch { mcpServerPath = undefined; }

let imported;
if (mcpServerPath !== undefined) {
  // Import in this process to avoid a second Node process for each session.
  // A child server would need a full MCP client proxy here to inspect its tools
  // and provide a clean empty fallback. Import failures can reach that fallback directly.
  try { imported = await import(pathToFileURL(mcpServerPath).href); }
  catch { imported = undefined; }
}
// Older installations can resolve and import successfully yet export only createArchstrictMcpServer.
// Those successes do not establish this newer entry point. Check its shape before
// an unconditional call to a missing function would throw a TypeError.
if (typeof imported?.startArchstrictMcpServer === "function") {
  await imported.startArchstrictMcpServer(root);
// Missing, broken, and incompatible installations all lack usable architecture queries.
// One stub gives clients the same connected, empty result for all three states;
// separate fallbacks would falsely suggest different degrees of usable connection.
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
      // JSON-RPC and MCP notifications have no id and must receive no response.
      // A reply would be an unsolicited message that violates the client's protocol expectations.
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
