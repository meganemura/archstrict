#!/usr/bin/env node
// Responsibility: the PreToolUse hook. It builds the file text an
// Edit/Write/MultiEdit would produce and runs the edited project's own
// installed `archstrict simulate --json` against that one change.
// The default result omits permissionDecision. "allow" would skip the
// permission prompt for an edit that adds a violation, so the preview
// travels as additionalContext alone and the prompt stays.
// ARCHSTRICT_PRETOOLUSE=deny still returns permissionDecision "deny"
// and stops the write. permissionDecision "ask" is not implemented.
// Boundary: no rule logic here. This only shells out to the project's own
// `archstrict` binary and reshapes its JSON, mirroring post-tool-use.mjs.
// It never runs this repository's own dist/cli.js. The hook ships to other
// projects, each with its own installed archstrict.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

// 10s covers simulate's own measured cost (about twice `check <file>`,
// which reads the edge cache) on a real project; configurable because a
// large monorepo's cold run can exceed it. A hook that stalls the tool
// call for longer than the agent's patience defeats its own purpose.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SHOWN_VIOLATIONS = 5;

function readStdin() {
  return JSON.parse(readFileSync(0, "utf8"));
}

function emit(decision) {
  const output =
    decision === undefined
      ? {}
      : { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// `check` and `simulate` read archstrict.config.ts from their own working
// directory. The hook payload's cwd follows `cd`, and CLAUDE_PROJECT_DIR
// stays at the main checkout inside a git worktree, so neither names the
// edited file's project. Walk from the file. The nearest config wins, so
// a nested package is checked against its own config. This file ships
// alone and does not import the other hook; the same walk is copied there.
function projectDirectory(filePath) {
  let dir = resolve(dirname(filePath));
  for (;;) {
    if (existsSync(join(dir, "archstrict.config.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Applies one old_string -> new_string replacement the same way Edit and
// MultiEdit do. Returns undefined (not a thrown error) when old_string
// isn't found: the caller stays silent rather than guessing at the tool's
// own error text, since the tool itself will report that failure.
function applyReplacement(text, oldString, newString, replaceAll) {
  if (typeof oldString !== "string" || typeof newString !== "string") return undefined;
  if (!text.includes(oldString)) return undefined;
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
}

// Builds the file text the tool call would produce, without writing
// anything. Returns undefined when the input can't be built (a missing
// old_string, a file that doesn't exist yet for Edit/MultiEdit, or a
// malformed tool_input) - every such case stays silent per design, since
// the tool call itself will surface its own failure.
function proposedContent(toolName, toolInput, filePath) {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : undefined;
  }
  if (!existsSync(filePath)) return undefined;
  const current = readFileSync(filePath, "utf8");
  if (toolName === "Edit") {
    return applyReplacement(current, toolInput.old_string, toolInput.new_string, toolInput.replace_all === true);
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(toolInput.edits)) return undefined;
    let text = current;
    for (const edit of toolInput.edits) {
      const next = applyReplacement(text, edit?.old_string, edit?.new_string, edit?.replace_all === true);
      if (next === undefined) return undefined;
      text = next;
    }
    return text;
  }
  return undefined;
}

// Matches check.ts's own formatConfigPointerLines (`config-pointer.ts`'s
// ConfigPointers shape) - duplicated here, not imported, because this hook
// ships to other projects and only shells out to their installed
// archstrict; it never depends on this repository's own src.
function formatConfigPointerLines(config) {
  const pointers = Array.isArray(config) ? config : [config];
  return pointers.map(p => `  config: ${p.path}:${p.line}:${p.column} ${p.pointer} (${p.role})`);
}

function formatViolation(v) {
  return [
    `[${v.rule}] ${v.path}:${v.line}:${v.column}`,
    `  ${v.evidence}`,
    `  because: ${v.because}`,
    ...formatConfigPointerLines(v.config),
    `  do: ${v.do}`,
  ].join("\n");
}

function formatAdded(added, filePath) {
  const shown = added.slice(0, MAX_SHOWN_VIOLATIONS).map(formatViolation);
  const rest = added.length - shown.length;
  const restLine = rest > 0 ? `\n...and ${rest} more.` : "";
  return `archstrict: this edit would add ${added.length} violation(s) in ${filePath}:\n${shown.join("\n")}${restLine}`;
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

  const toolInput = input.tool_input;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== "string" || !/\.(ts|tsx|mts|cts)$/.test(filePath)) {
    emit();
    return;
  }

  const content = proposedContent(input.tool_name, toolInput, filePath);
  if (content === undefined) {
    emit();
    return;
  }

  // No config means this edit is outside an archstrict project, so there
  // is nothing to preview. The binary is the one next to the config, not
  // a binary that happens to sit in the hook cwd.
  const projectDir = projectDirectory(filePath);
  if (projectDir === undefined) {
    emit();
    return;
  }
  const binPath = join(projectDir, "node_modules", ".bin", "archstrict");
  if (!existsSync(binPath)) {
    emit();
    return;
  }

  const timeoutMs = Number(process.env.ARCHSTRICT_PRETOOLUSE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const stdinBody = JSON.stringify({ changes: [{ path: filePath, content }] });

  let stdout;
  try {
    stdout = execFileSync(binPath, ["simulate", "--json"], { cwd: projectDir, encoding: "utf8", input: stdinBody, timeout: timeoutMs });
  } catch (error) {
    // simulate exits 1 both when `added` is nonempty (real data, read from
    // stdout below) and on an input/config error ({ error, do } json) - a
    // timeout or a crash leaves no stdout at all. Unlike the PostToolUse
    // hook, a config error here stays silent rather than being reported:
    // this hook runs before every edit, so a broken project config would
    // otherwise interrupt every tool call instead of the one edit that
    // actually caused it.
    const execError = error;
    if (typeof execError.stdout !== "string" || execError.stdout.length === 0) {
      emit();
      return;
    }
    stdout = execError.stdout;
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    emit();
    return;
  }
  if (typeof result.error === "string" || !Array.isArray(result.added) || result.added.length === 0) {
    emit();
    return;
  }

  const resolvedLine = result.resolved?.length > 0 ? `\narchstrict: this edit would also resolve ${result.resolved.length} violation(s).` : "";
  const text = `${formatAdded(result.added, filePath)}${resolvedLine}`;

  if (process.env.ARCHSTRICT_PRETOOLUSE === "deny") {
    emit({ permissionDecision: "deny", permissionDecisionReason: text });
    return;
  }
  emit({ additionalContext: text });
}

main();
