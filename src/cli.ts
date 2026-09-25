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
import { ReportError } from "./report-error.js";

// Text and JSON share one shape: the message, then the one command to run.
// A violation already carries `do`; a thrown config or missing-file
// failure goes through here so it does too.
function reportFailure(error: unknown, verb: string, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  const doText = error instanceof ReportError ? error.do : `archstrict ${verb}`;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ error: message, do: doText })}\n`);
  } else {
    process.stderr.write(`archstrict: ${message}\ndo: ${doText}\n`);
  }
}

// `--json` is a flag, never read as a directory, so it's stripped before
// the positional rules apply. Every other argument is a directory, so any
// other flag-looking argument ("-" prefix) is rejected outright rather
// than silently accepted as a directory name. More than one positional
// means the shell expanded an unquoted glob (`src/*` with more than one
// match) - archstrict cannot tell that apart from a person genuinely
// typing two directory names, so both read the same way: init takes
// exactly one.
function parseInitArgv(argv: string[]): string | undefined {
  const positional = argv.filter((arg) => arg !== "--json");
  for (const arg of positional) {
    if (arg.startsWith("-")) throw new ReportError(`unknown option '${arg}'`, "archstrict init");
  }
  if (positional.length > 1) {
    throw new ReportError(
      `init takes one directory; got ${positional.length} arguments (the shell expands an unquoted * or src/*)`,
      "archstrict init",
    );
  }
  return positional[0];
}

async function runInit(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const result = await init(process.cwd(), parseInitArgv(args));
  if (asJson) {
    // Field names and shapes follow check's and todo's own --json
    // convention: one object, keys in the same order this prints them.
    // `typesPath` (not `generatedPath`, InitResult's own internal name)
    // matches archstrict.types.ts's own file name, which is what an agent
    // reading this JSON actually needs to find.
    process.stdout.write(
      `${JSON.stringify({
        configPath: result.configPath,
        typesPath: result.generatedPath,
        configWritten: result.configWritten,
        opened: result.opened === "" ? null : result.opened,
        moduleNames: result.moduleNames,
        hiddenDirs: result.hiddenDirs,
        noiseDirs: result.noiseDirs,
        testFileExcludes: result.testFileExcludes.map((t) => ({ pattern: t.label, exclude: t.exclude, files: t.fileCount })),
        uncovered: result.uncovered.map((g) => ({
          path: g.rel,
          kind: g.kind,
          files: g.fileCount,
          declare: g.entry,
          exclude: g.excludeGlob,
        })),
        notes: result.notes,
        do: result.doText,
      })}\n`,
    );
    return 0;
  }
  for (const line of result.messageLines) process.stdout.write(`${line}\n`);
  process.stdout.write(`do: ${result.doText}\n`);
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
  process.stdout.write(`do: archstrict check\n`);
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

async function runRecommend(args: string[]): Promise<number> {
  const paths = args.filter(arg => arg !== "--json");
  if (paths.length > 1 || paths.some(arg => arg.startsWith("-"))) {
    throw new Error("usage: archstrict recommend [dir] [--json]");
  }
  // Without a config, the directory controls init's own in-memory walk; a
  // declared config supplies its own scope regardless.
  const result = await recommend(process.cwd(), paths[0]);
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
    if (verb === "recommend") return await runRecommend(rest);
    if (verb === "init") return await runInit(rest);
    if (verb === "check") return await runCheck(rest);
    if (verb === "todo") return await runTodo(rest);
    if (verb === "rules") return await runRules(rest);
    if (verb === "agents") return runAgents(rest);
    process.stderr.write(`archstrict: '${verb}' is not implemented yet\ndo: archstrict init\n`);
    return 1;
  } catch (error) {
    // A config or missing-file error throws before any real output.
    // reportFailure prints the message and a do: line — the same pair
    // a violation carries — instead of a bare message or stack trace.
    reportFailure(error, verb, rest.includes("--json"));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
