#!/usr/bin/env node
// Responsibility: the PostToolUse hook. Runs the edited project's own
// installed `archstrict check <file>` right after Edit/Write/MultiEdit and
// feeds any violation back into the agent's context via
// hookSpecificOutput.additionalContext - the same moment a human editor's
// red squiggly would appear, per code.claude.com/docs/en/hooks.
// Boundary: no rule logic here - this only shells out to the project's own
// `archstrict` binary and reshapes its JSON. It never runs this
// repository's own dist/cli.js: the hook ships to OTHER projects, each
// with its own installed archstrict and its own archstrict.config.ts.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function readStdin() {
  return JSON.parse(readFileSync(0, "utf8"));
}

// Every path writes exactly one line of JSON to stdout and exits 0 - a
// hook that fails loudly would block the edit it's only meant to comment
// on. `additionalContext` omitted (not merely empty) when there is
// nothing to say: an empty string is still a context entry Claude reads.
function emit(additionalContext) {
  const output =
    additionalContext === undefined
      ? {}
      : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function main() {
  let input;
  try {
    input = readStdin();
  } catch {
    emit();
    return;
  }

  const editTools = new Set(["Edit", "Write", "MultiEdit"]);
  if (!editTools.has(input.tool_name)) {
    emit();
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath.endsWith(".ts")) {
    emit();
    return;
  }

  // The edited project's own cwd, not this plugin's own install
  // location: check <file> resolves archstrict.config.ts from cwd, and a
  // project checked with this hook is never this repository itself.
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const binPath = join(cwd, "node_modules", ".bin", "archstrict");
  if (!existsSync(binPath)) {
    // Not an error: most edits happen in files or projects with no
    // archstrict installed at all. Said once, not raised as a failure -
    // the hook's job is to add context when there is real feedback to
    // add, not to insist a project adopt this tool.
    emit();
    return;
  }

  let stdout;
  try {
    stdout = execFileSync(binPath, ["check", filePath, "--json"], { cwd, encoding: "utf8" });
  } catch (error) {
    // check exits 1 exactly when violations exist (module-graph.ts's own
    // documented contract) - that is real data on stderr's sibling
    // stdout, not a hook failure. Only a stdout-less failure (the binary
    // itself couldn't run) is reported as broken.
    const execError = /** @type {{ stdout?: unknown; message: string }} */ (error);
    if (typeof execError.stdout !== "string" || execError.stdout.length === 0) {
      emit(`archstrict: check did not run (${execError.message}).`);
      return;
    }
    stdout = execError.stdout;
  }

  const result = JSON.parse(stdout);
  if (result.violations.length === 0) {
    emit();
    return;
  }

  const lines = result.violations.map(
    (v) => `[${v.rule}] ${v.path}:${v.line}:${v.column}\n  ${v.evidence}\n  because: ${v.because}\n  next: ${v.next}`,
  );
  emit(`archstrict found ${result.violations.length} violation(s) in ${filePath}:\n${lines.join("\n")}`);
}

main();
