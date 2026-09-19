#!/usr/bin/env node
// Responsibility: parse argv and dispatch to a verb (init, check, todo).
// Boundary: no rule logic here; verbs live in their own modules.

function main(argv: string[]): number {
  const [verb] = argv;
  if (verb === undefined) {
    process.stderr.write("usage: archstrict <init|check|todo> [args]\n");
    return 1;
  }
  process.stderr.write(`archstrict: '${verb}' is not implemented yet\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
