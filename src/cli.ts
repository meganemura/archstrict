#!/usr/bin/env node
// Responsibility: parse argv and dispatch to a verb (init, check, todo, rules, agents, recommend, fix, simulate, search, hotspots, mcp).
// Boundary: no rule logic here; verbs live in their own modules.
// Help is printed from the usage table before dispatch. A help flag must not reach a verb that writes files.
// Each verb is imported when it runs. The verbs reach the TypeScript compiler and the MCP SDK, and
// loading them was 94% of a 0.5 s `--help`: a CPU profile of that run put the time in module
// loading, not in any archstrict code. Help, an unknown verb, and a bad flag load none of them.
import type { Change } from "./verbs/simulate.js";
import { ReportError } from "./report-error.js";
import { parseCheckArgv } from "./check-options.js";

// One table, keyed by verb. Help and an unknown verb both print it, so a second usage string cannot drift.
// `writes` marks the verbs that create or edit project files. Help returns before those verbs run.
const usage = {
  init: {
    args: "[dir] [--json]",
    sentence: "Declare one module per top-level source directory and write archstrict.config.ts and archstrict.types.ts.",
    writes: true,
  },
  check: {
    args: "[file] [--json] [--rule <id>] [--module <name>] [--frozen] [--prove]",
    sentence: "Report module-boundary violations for the project, or for one file.",
    writes: false,
  },
  todo: {
    args: "[--json]",
    sentence: "Freeze current freezable violations on the first run, then only prune.",
    writes: true,
  },
  rules: {
    args: "<path> [--json]",
    sentence: "Report the module, tags, and constraints that govern a path.",
    writes: false,
  },
  agents: {
    args: "[--remove] [--json]",
    sentence: "Add or remove the archstrict section in AGENTS.md.",
    writes: true,
  },
  recommend: {
    args: "[dir] [--json]",
    sentence: "Propose map notes, boundary patterns, and surfaces from the project graph.",
    writes: false,
  },
  fix: {
    args: "[file] [--dry-run] [--json]",
    sentence: "Re-export a leaked type whose declaring file already exports that name.",
    writes: true,
  },
  simulate: {
    args: "[--json] [--whole-project]",
    sentence: "Preview a JSON change set from stdin without writing it.",
    writes: false,
  },
  search: {
    args: "<query> [--json]",
    sentence: "Rank names exported from public surfaces by token overlap with the query.",
    writes: false,
  },
  hotspots: {
    args: "[--since <git ref or date>] [--json]",
    sentence: "Rank modules by git change frequency, fan-in, and violations.",
    writes: false,
  },
  mcp: {
    args: "",
    sentence: "Start the stdio MCP server for check, rules, search, and simulate.",
    writes: false,
  },
} as const;

type VerbName = keyof typeof usage;

const verbNames = Object.keys(usage) as VerbName[];

function isVerbName(value: string): value is VerbName {
  return Object.hasOwn(usage, value);
}

function usageLine(verb: VerbName): string {
  const entry = usage[verb];
  const invocation = entry.args.length === 0 ? `archstrict ${verb}` : `archstrict ${verb} ${entry.args}`;
  const mark = entry.writes ? " [writes files]" : "";
  return `${invocation}: ${entry.sentence}${mark}`;
}

function usageTable(): string {
  return `usage:\n${verbNames.map((verb) => `  ${usageLine(verb)}`).join("\n")}\n`;
}

// `--help` and `-h` count anywhere. `help` counts only as the verb, so `search help` still searches.
function isHelpRequest(argv: readonly string[]): boolean {
  return argv[0] === "help" || argv.some((arg) => arg === "--help" || arg === "-h");
}

// The first token is the verb when it names one, so a later value that
// happens to be a verb (`check --module init --help`) still selects that line.
// `help`, `--help`, or `-h` in front looks at the remaining tokens.
function helpVerb(argv: readonly string[]): VerbName | undefined {
  const head = argv[0];
  if (head !== undefined && isVerbName(head)) return head;
  const rest = head === "help" || head === "--help" || head === "-h" ? argv.slice(1) : argv;
  const named = rest.filter(isVerbName);
  return named.length === 1 ? named[0] : undefined;
}

// Text and JSON share one shape: the message, then the one command to run.
// A violation already carries `do`; a thrown config or missing-file
// failure goes through here so it does too.
function reportFailure(error: unknown, verb: string, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  // A ReportError already names the next command. A plain Error does not,
  // and repeating the verb that just failed leaves the reader on that same command.
  const doText = error instanceof ReportError ? error.do : `archstrict ${verb} --help`;
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
  const { init } = await import("./verbs/init.js");
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
  const parsed = parseCheckArgv(args);
  const { check, formatText, hasBlockingViolations } = await import("./verbs/check.js");
  const result = await check(process.cwd(), parsed.focusFile, {
    prove: parsed.prove,
    rules: parsed.rules,
    modules: parsed.modules,
    frozen: parsed.frozen,
    json: parsed.asJson,
  });
  if (parsed.asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatText(result));
  }
  return hasBlockingViolations(result) ? 1 : 0;
}

async function runTodo(args: string[]): Promise<number> {
  // main answers --help before dispatch, so this function never sees it.
  // The first run is the only run that writes new entries. Any argument
  // other than `--json` fails before that write, so a dry run cannot
  // spend the one freeze.
  for (const arg of args) {
    if (arg !== "--json") throw new ReportError(`unknown option '${arg}'`, "archstrict todo [--json]");
  }
  const asJson = args.includes("--json");
  const { todo } = await import("./verbs/todo.js");
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
  for (const note of result.notes ?? []) process.stdout.write(`note: ${note}\n`);
  process.stdout.write(result.notes !== undefined && result.notes.length > 0
    ? `do: split the module named above before treating this freeze as done\n`
    : `do: archstrict check\n`);
  return 0;
}

async function runRules(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const paths = args.filter((arg) => arg !== "--json");
  if (paths.length !== 1) throw new Error("usage: archstrict rules <path> [--json]");
  const { rules, formatRulesText } = await import("./verbs/rules.js");
  const result = await rules(process.cwd(), paths[0]!);
  process.stdout.write(asJson ? JSON.stringify(result, null, 2) + "\n" : formatRulesText(result));
  return 0;
}

async function runAgents(args: string[]): Promise<number> {
  if (args.some((arg) => arg !== "--json" && arg !== "--remove")) {
    throw new Error("usage: archstrict agents [--remove] [--json]");
  }
  const { agents, formatAgentsText } = await import("./verbs/agents.js");
  const result = agents(process.cwd(), args.includes("--remove"));
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatAgentsText(result));
  return 0;
}

async function runRecommend(args: string[]): Promise<number> {
  const paths = args.filter(arg => arg !== "--json");
  if (paths.length > 1 || paths.some(arg => arg.startsWith("-"))) {
    throw new Error("usage: archstrict recommend [dir] [--json]");
  }
  const { recommend, formatRecommendText } = await import("./verbs/recommend.js");
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
  const { fix, formatFixText } = await import("./verbs/fix.js");
  const dryRun = args.includes("--dry-run");
  const result = await fix(process.cwd(), paths[0], dryRun);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatFixText(result));
  return dryRun || (result.unfixable.length === 0 && result.reverted.length === 0) ? 0 : 1;
}

async function runSimulate(args: string[]): Promise<number> {
  if (args.some(arg => arg !== "--json" && arg !== "--whole-project")) {
    throw new Error("usage: archstrict simulate [--json] [--whole-project]");
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const body: unknown = JSON.parse(input);
  if (typeof body !== "object" || body === null || !("changes" in body) || !Array.isArray(body.changes)) {
    throw new Error("stdin must contain a JSON object with a changes array");
  }
  const { simulate, formatSimulateText } = await import("./verbs/simulate.js");
  const result = await simulate(process.cwd(), body.changes as Change[], { wholeProject: args.includes("--whole-project") });
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatSimulateText(result));
  return result.added.length === 0 ? 0 : 1;
}

async function runSearch(args: string[]): Promise<number> {
  const query = args.filter(arg => arg !== "--json").join(" ");
  const { search, formatSearchText } = await import("./verbs/search.js");
  const result = await search(process.cwd(), query);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatSearchText(result));
  return 0;
}

async function runHotspots(args: string[]): Promise<number> {
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--since" && since === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) {
      since = args[++i];
      continue;
    }
    throw new Error("usage: archstrict hotspots [--since <git ref or date>] [--json]");
  }
  const { hotspots, formatHotspotsText } = await import("./verbs/hotspots.js");
  const result = await hotspots(process.cwd(), since);
  process.stdout.write(args.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatHotspotsText(result));
  return 0;
}

// The connected transport's stdin listener keeps Node alive after this function returns.
// A real subprocess stayed alive with stdin open and exited when stdin closed;
// the host can also terminate it. A separate server-closed promise is unnecessary.
async function runMcp(): Promise<number> {
  const { startArchstrictMcpServer } = await import("./mcp-server.js");
  await startArchstrictMcpServer(process.cwd());
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (isHelpRequest(argv)) {
    const verb = helpVerb(argv);
    process.stdout.write(verb === undefined ? usageTable() : `${usageLine(verb)}\n`);
    return 0;
  }
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    process.stderr.write(usageTable());
    return 1;
  }
  if (!isVerbName(verb)) {
    process.stderr.write(`archstrict: unknown verb '${verb}'\n${usageTable()}`);
    return 1;
  }
  try {
    if (verb === "mcp") return await runMcp();
    if (verb === "search") return await runSearch(rest);
    if (verb === "hotspots") return await runHotspots(rest);
    if (verb === "simulate") return await runSimulate(rest);
    if (verb === "fix") return await runFix(rest);
    if (verb === "recommend") return await runRecommend(rest);
    if (verb === "init") return await runInit(rest);
    if (verb === "check") return await runCheck(rest);
    if (verb === "todo") return await runTodo(rest);
    if (verb === "rules") return await runRules(rest);
    if (verb === "agents") return await runAgents(rest);
    const unexpected: never = verb;
    throw new Error(`usage: ${usageLine(unexpected)}`);
  } catch (error) {
    // A config or missing-file error throws before any real output.
    // reportFailure prints the message and a do: line — the same pair
    // a violation carries — instead of a bare message or stack trace.
    reportFailure(error, verb, rest.includes("--json"));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
