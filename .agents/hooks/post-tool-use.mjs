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
import { dirname, join, resolve } from "node:path";

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

// `check` reads archstrict.config.ts from its own working directory. The
// hook payload's cwd follows `cd`, and CLAUDE_PROJECT_DIR stays at the
// main checkout inside a git worktree, so neither names the edited file's
// project. Walk from the file. The nearest config wins, so a nested
// package is checked against its own config. This file ships alone and
// does not import the other hook; the same walk is copied there.
function projectDirectory(filePath) {
  let dir = resolve(dirname(filePath));
  for (;;) {
    if (existsSync(join(dir, "archstrict.config.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
  if (typeof filePath !== "string" || !/\.(ts|tsx|mts|cts)$/.test(filePath)) {
    emit();
    return;
  }

  // No config means this edit is outside an archstrict project. Stay
  // silent even when a binary sits in the hook cwd: that binary's check
  // would print `do: archstrict init` on every TypeScript edit, and the
  // agents guidance says to skip archstrict when no config exists. The
  // binary is the one next to the config, not one in a parent or in cwd.
  const projectDir = projectDirectory(filePath);
  if (projectDir === undefined) {
    emit();
    return;
  }
  const binPath = join(projectDir, "node_modules", ".bin", "archstrict");
  if (!existsSync(binPath)) {
    // Not an error: most edits happen in files or projects with no
    // archstrict installed at all. Said once, not raised as a failure.
    // The hook adds context when there is real feedback, and does not
    // insist a project adopt this tool.
    emit();
    return;
  }

  let stdout;
  try {
    stdout = execFileSync(binPath, ["check", filePath, "--json"], { cwd: projectDir, encoding: "utf8" });
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

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    // Same guard as pre-tool-use.mjs. Text on stdout is not a check
    // result. Throwing here would exit 1 and block the edit this hook
    // only comments on.
    emit();
    return;
  }
  // A config or missing-file error (a required field absent, an
  // unsupported edges shape) reports as { error, do } instead of a
  // real CheckResult, exit 1, no stdout-less failure - so the branch
  // above never catches it. Surfaced, not silently ignored: the project
  // has archstrict installed but something about its own setup is broken,
  // which the agent editing it needs to know, the same as a real
  // violation would. `do` is the command to run; older binaries that
  // omit it still surface the error text. Output that parses and is
  // still not a check result stays silent, same as text that does not
  // parse: there is no violations list to report.
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    emit();
    return;
  }
  if (typeof result.error === "string") {
    const doText = typeof result.do === "string" && result.do.length > 0 ? `\ndo: ${result.do}` : "";
    emit(`archstrict: check did not run (${result.error}).${doText}`);
    return;
  }
  if (!Array.isArray(result.violations) || result.violations.length === 0) {
    emit();
    return;
  }

  const lines = result.violations.map(
    (v) => `[${v.rule}] ${v.path}:${v.line}:${v.column}\n  ${v.evidence}\n  because: ${v.because}\n  do: ${v.do}`,
  );
  emit(`archstrict found ${result.violations.length} violation(s) in ${filePath}:\n${lines.join("\n")}`);
}

main();
