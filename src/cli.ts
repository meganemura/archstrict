#!/usr/bin/env node
// Responsibility: parse argv and dispatch to a verb (init, check, todo).
// Boundary: no rule logic here; verbs live in their own modules.
import { init } from "./verbs/init.js";
import { check, formatText } from "./verbs/check.js";

function runInit(): number {
  const result = init(process.cwd());
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
  const result = await check(process.cwd(), "src/*", focusFile);
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatText(result));
  }
  return result.violations.length > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    process.stderr.write("usage: archstrict <init|check|todo> [args]\n");
    return 1;
  }
  if (verb === "init") return runInit();
  if (verb === "check") return runCheck(rest);
  process.stderr.write(`archstrict: '${verb}' is not implemented yet\n`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
