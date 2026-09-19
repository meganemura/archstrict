#!/usr/bin/env node
// Responsibility: parse argv and dispatch to a verb (init, check, todo).
// Boundary: no rule logic here; verbs live in their own modules.
import { init } from "./verbs/init.js";

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

function main(argv: string[]): number {
  const [verb] = argv;
  if (verb === undefined) {
    process.stderr.write("usage: archstrict <init|check|todo> [args]\n");
    return 1;
  }
  if (verb === "init") return runInit();
  process.stderr.write(`archstrict: '${verb}' is not implemented yet\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
