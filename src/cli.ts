#!/usr/bin/env node
// Responsibility: parse argv and dispatch to a verb (init, check, todo, rules, agents, recommend, fix, simulate, search).
// Boundary: no rule logic here; verbs live in their own modules.
import { startArchstrictMcpServer } from "./mcp-server.js";
import { search, formatSearchText } from "./verbs/search.js";
import { simulate, formatSimulateText, type Change } from "./verbs/simulate.js";
import { agents, formatAgentsText } from "./verbs/agents.js";
import { recommend, formatRecommendText } from "./verbs/recommend.js";
import { fix, formatFixText } from "./verbs/fix.js";
import { init } from "./verbs/init.js";
import { check, formatText, hasBlockingViolations } from "./verbs/check.js";
import { todo } from "./verbs/todo.js";
import { rules, formatRulesText } from "./verbs/rules.js";

function runInit(args: string[]): number {
  const [modulesGlob] = args;
  const result = init(process.cwd(), modulesGlob);
  process.stdout.write(`wrote ${result.generatedPath}\n`);
  if (result.configWritten) {
    process.stdout.write(`wrote ${result.configPath}\n`);
  } else {
    process.stdout.write(`${result.configPath} already exists, left untouched\n`);
  }
  process.stdout.write(`next: archstrict check\n`);
  return 0;
}

async function runCheck(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const [focusFile] = args.filter((a) => a !== "--json" && a !== "--prove");
  const result = await check(process.cwd(), focusFile, { prove: args.includes("--prove") });
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatText(result));
  }
  return hasBlockingViolations(result) ? 1 : 0;
}

async function runTodo(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const result = await todo(process.cwd());
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (result.firstRun) {
    process.stdout.write(`froze ${result.added} violation(s)\n`);
  } else {
    process.stdout.write(`pruned ${result.pruned} stale entrie(s)\n`);
  }
  process.stdout.write(`next: archstrict check\n`);
  return 0;
}

async function runRules(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const paths = args.filter((arg) => arg !== "--json");
  if (paths.length !== 1) throw new Error("usage: archstrict rules <path> [--json]");
  const result = await rules(process.cwd(), paths[0]!);
  process.stdout.write(asJson ? JSON.stringify(result, null, 2) + "\n" : formatRulesText(result));
  return 0;
}

function runAgents(args: string[]): number {
  if (args.some((arg) => arg !== "--json" && arg !== "--remove")) {
    throw new Error("usage: archstrict agents [--remove] [--json]");
  }
  const result = agents(process.cwd(), args.includes("--remove"));
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatAgentsText(result));
  return 0;
}

function runRecommend(args: string[]): number {
  const paths = args.filter(arg => arg !== "--json");
  if (paths.length > 1 || paths.some(arg => arg.startsWith("-"))) {
    throw new Error("usage: archstrict recommend [modulesGlob] [--json]");
  }
  const result = recommend(process.cwd(), paths[0]);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatRecommendText(result));
  return 0;
}

async function runFix(args: string[]): Promise<number> {
  const paths = args.filter(arg => arg !== "--json" && arg !== "--dry-run");
  if (paths.length > 1 || paths.some(arg => arg.startsWith("-"))) {
    throw new Error("usage: archstrict fix [file] [--dry-run] [--json]");
  }
  const dryRun = args.includes("--dry-run");
  const result = await fix(process.cwd(), paths[0], dryRun);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatFixText(result));
  return dryRun || (result.unfixable.length === 0 && result.reverted.length === 0) ? 0 : 1;
}

async function runSimulate(args: string[]): Promise<number> {
  if (args.some(arg => arg !== "--json")) throw new Error("usage: archstrict simulate [--json]");
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const body: unknown = JSON.parse(input);
  if (typeof body !== "object" || body === null || !("changes" in body) || !Array.isArray(body.changes)) {
    throw new Error("stdin must contain a JSON object with a changes array");
  }
  const result = await simulate(process.cwd(), body.changes as Change[]);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatSimulateText(result));
  return result.added.length === 0 ? 0 : 1;
}

async function runSearch(args: string[]): Promise<number> {
  const query = args.filter(arg => arg !== "--json").join(" ");
  const result = await search(process.cwd(), query);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatSearchText(result));
  return 0;
}

// The connected transport's stdin listener keeps Node alive after this function returns.
// A real subprocess stayed alive with stdin open and exited when stdin closed;
// the host can also terminate it. A separate server-closed promise is unnecessary.
async function runMcp(): Promise<number> {
  await startArchstrictMcpServer(process.cwd());
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    process.stderr.write("usage: archstrict <init|check|todo|rules|agents|recommend|fix|simulate|search|mcp> [args]\n");
    return 1;
  }
  try {
    if (verb === "mcp") return await runMcp();
    if (verb === "search") return await runSearch(rest);
    if (verb === "simulate") return await runSimulate(rest);
    if (verb === "fix") return await runFix(rest);
    if (verb === "recommend") return runRecommend(rest);
    if (verb === "init") return runInit(rest);
    if (verb === "check") return await runCheck(rest);
    if (verb === "todo") return await runTodo(rest);
    if (verb === "rules") return await runRules(rest);
    if (verb === "agents") return runAgents(rest);
    process.stderr.write(`archstrict: '${verb}' is not implemented yet\n`);
    return 1;
  } catch (error) {
    // A config or missing-file error (a required field absent, an
    // unsupported kinds pattern shape, check <file> naming a file that
    // doesn't exist, the modules glob's root not existing yet) throws
    // before any real output - previously an unhandled exception, a raw
    // stack trace with no rule id, no because, no next:. Every other
    // error this tool reports carries those; this is the one path that
    // didn't, and it's the path a first attempt (a hand-written config
    // with a typo, a mistyped file path) is most likely to hit.
    const message = error instanceof Error ? error.message : String(error);
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    } else {
      process.stderr.write(`archstrict: ${message}\n`);
    }
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
