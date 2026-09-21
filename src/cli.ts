#!/usr/bin/env node
// Responsibility: parse argv and dispatch to a verb (init, check, todo, rules).
// Boundary: no rule logic here; verbs live in their own modules.
import { init } from "./verbs/init.js";
import { check, formatText } from "./verbs/check.js";
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
  const [focusFile] = args.filter((a) => a !== "--json");
  const result = await check(process.cwd(), focusFile);
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatText(result));
  }
  return result.violations.length > 0 ? 1 : 0;
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

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    process.stderr.write("usage: archstrict <init|check|todo|rules> [args]\n");
    return 1;
  }
  try {
    if (verb === "init") return runInit(rest);
    if (verb === "check") return await runCheck(rest);
    if (verb === "todo") return await runTodo(rest);
    if (verb === "rules") return await runRules(rest);
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
