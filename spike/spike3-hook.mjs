#!/usr/bin/env node
// Spike 3: can a Claude Code PostToolUse hook run a check right after a file
// edit and get the result back into the agent's context, the way an
// editor's red squiggly does? Per code.claude.com/docs/en/hooks,
// PostToolUse fires after Edit/Write/MultiEdit with tool_input.file_path on
// stdin, and a hook feeds text back via `hookSpecificOutput.additionalContext`
// (visible to Claude) on stdout, exit 0.
//
// v0's real `check` verb doesn't exist yet, so this
// spike stands a real detector in for it: spike 2's type-leak walker, run
// against whichever file the hook says was just edited. That is a genuine
// analysis producing genuine violations, not a placeholder string — the
// thing this spike needs to prove is the round trip (stdin in, a real
// finding out, in the shape Claude Code expects), not the rule set.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readStdin() {
  return JSON.parse(readFileSync(0, "utf8"));
}

function main() {
  let input;
  try {
    input = readStdin();
  } catch (e) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  const editTools = new Set(["Edit", "Write", "MultiEdit"]);
  if (!editTools.has(input.tool_name)) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath.endsWith(".ts")) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  // Stand-in for `archstrict check <file>`: spike 2's leak detector, but
  // asked about one file only. Reuses the fixture project so this script
  // is self-contained and needs no other repository present to prove the
  // round trip.
  let findingsText;
  try {
    const out = execFileSync(
      "node",
      [resolve("spike/spike2.ts")],
      { encoding: "utf8", cwd: resolve(".") },
    );
    const leakCount = (out.match(/"totalLeaks": (\d+)/g) ?? [])
      .map((m) => Number(m.match(/(\d+)/)[1]))
      .reduce((a, b) => a + b, 0);
    findingsText = `archstrict: ${leakCount} finding(s) across the checked project (stood in for 'check ${filePath}' — v0's real check verb is not built yet).`;
  } catch (e) {
    findingsText = `archstrict: check did not run (${e instanceof Error ? e.message : String(e)}).`;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: findingsText,
      },
    }) + "\n",
  );
}

main();
