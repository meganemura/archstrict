#!/usr/bin/env node
// Responsibility: the PreToolUse hook. Before an Edit/Write/MultiEdit
// actually touches disk, this builds the file text the tool call would
// produce and runs the edited project's own installed
// `archstrict simulate --json` against that one change, so the agent
// hears about a new violation before the write happens instead of after
// (the PostToolUse hook's own moment). Per code.claude.com/docs/en/hooks,
// PreToolUse returns its decision inside hookSpecificOutput:
// permissionDecision ("allow"/"deny"/"ask"/"defer") plus
// permissionDecisionReason, or additionalContext alongside "allow".
// Boundary: no rule logic here - this only shells out to the project's own
// `archstrict` binary and reshapes its JSON, mirroring post-tool-use.mjs.
// It never runs this repository's own dist/cli.js: the hook ships to OTHER
// projects, each with its own installed archstrict.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

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

  // The edited project's own cwd, matching the PostToolUse hook's own
  // resolution: never this plugin's own install location.
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const binPath = join(cwd, "node_modules", ".bin", "archstrict");
  if (!existsSync(binPath)) {
    emit();
    return;
  }

  const timeoutMs = Number(process.env.ARCHSTRICT_PRETOOLUSE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const stdinBody = JSON.stringify({ changes: [{ path: filePath, content }] });

  let stdout;
  try {
    stdout = execFileSync(binPath, ["simulate", "--json"], { cwd, encoding: "utf8", input: stdinBody, timeout: timeoutMs });
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
  emit({ permissionDecision: "allow", additionalContext: text });
}

main();
