// Responsibility: the on-disk shape of a module's frozen violations
// (archstrict.todo.json) and the identity (fingerprint) that ties a todo
// entry to a violation across runs. Shared by check.ts (suppresses a
// violation whose fingerprint is already frozen, and flags a todo entry
// that matches nothing as stale) and todo.ts (writes the file) so neither
// has to depend on the other — both depend on this instead.
// Boundary: file I/O and the fingerprint's own definition only. No rule
// logic, no freeze/prune policy (that's todo.ts's job).
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { REFERENCED_BY_MARKER } from "./rules/type-leak.js";

export type TodoEntry = {
  fingerprint: string;
  rule: string;
  path: string;
  evidence: string;
};

// Identity for a violation across runs: rule, importing path, and the
// evidence text — no line number (a line moving is not a new violation;
// archspec's own fingerprint makes the same choice).
//
// One exception: a cycle's own `path` is `firstEdge.fromFile` — the file
// of one arbitrary edge in the cycle, an implementation detail of which
// edge the shortest-path search happened to return first, not the
// cycle's own identity. The cycle itself (`evidence`, e.g. "a -> b -> c
// -> a") is the identity; if that one file moved but the same cycle
// still existed, including `path` would change the fingerprint and the
// frozen entry would go stale for a cycle that never actually changed.
// Every other rule's `path` names the real thing the violation is about
// (the importing file, or the config file), so only "cycle" is excluded.
// Hashed so the todo file's own key is short and stable regardless of how
// long the evidence text is.
//
// A second exception, the same reasoning applied to a different rule:
// type-leak's own evidence embeds a mutable, informational list of every
// exported symbol CURRENTLY referencing a leaked internal type, after
// REFERENCED_BY_MARKER - not part of the leak's own identity (module,
// internal type, and its declaring file already fully identify it, and
// all three appear in evidence's own stable prefix, before the marker).
// Without stripping it, one more real caller of an already-frozen leak
// appearing would change the fingerprint and reopen a frozen entry for a
// leak that hasn't newly appeared - measured directly: freezing a leak
// referenced by one export, then adding a second real export referencing
// the same internal type, produced both a stale-todo violation for the
// old entry and a fresh, unfrozen one for what is still the same leak.
function stableEvidence(rule: string, evidence: string): string {
  if (rule !== "type-leak") return evidence;
  const i = evidence.indexOf(REFERENCED_BY_MARKER);
  return i === -1 ? evidence : evidence.slice(0, i);
}

export function fingerprintOf(v: { rule: string; path: string; evidence: string }): string {
  const evidence = stableEvidence(v.rule, v.evidence);
  const key = v.rule === "cycle" ? `${v.rule}\n${evidence}` : `${v.rule}\n${v.path}\n${evidence}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function pathIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function todoPath(moduleDir: string): string {
  // `module.dir` is the glob's literal prefix. A declaredModules entry may
  // name one file (`glob: "src/index.ts"`), so that prefix is the file.
  // Joining `archstrict.todo.json` onto a file asks the kernel for a
  // directory entry inside a file and throws ENOTDIR. The store sits
  // beside the file, named with that file's own basename, so two file
  // modules in one directory do not share one todo. Putting a single
  // `archstrict.todo.json` in the parent was refused for that collision:
  // the second module's write would replace the first.
  if (pathIsFile(moduleDir)) {
    return join(dirname(moduleDir), `${basename(moduleDir)}.archstrict.todo.json`);
  }
  return join(moduleDir, "archstrict.todo.json");
}

export function readTodo(moduleDir: string): TodoEntry[] {
  const p = todoPath(moduleDir);
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")) as { entries: TodoEntry[] }).entries;
}

export function writeTodo(moduleDir: string, entries: TodoEntry[]): void {
  const p = todoPath(moduleDir);
  if (entries.length === 0) {
    if (existsSync(p)) unlinkSync(p);
    return;
  }
  writeFileSync(p, JSON.stringify({ entries }, null, 2) + "\n");
}
