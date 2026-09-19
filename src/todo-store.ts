// Responsibility: the on-disk shape of a module's frozen violations
// (archstrict.todo.json) and the identity (fingerprint) that ties a todo
// entry to a violation across runs. Shared by check.ts (suppresses a
// violation whose fingerprint is already frozen, and flags a todo entry
// that matches nothing as stale) and todo.ts (writes the file) so neither
// has to depend on the other — both depend on this instead.
// Boundary: file I/O and the fingerprint's own definition only. No rule
// logic, no freeze/prune policy (that's todo.ts's job).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type TodoEntry = {
  fingerprint: string;
  rule: string;
  path: string;
  evidence: string;
};

// Identity for a violation across runs: rule, importing path, and the
// evidence text — no line number (a line moving is not a new violation;
// archspec's own fingerprint makes the same choice). Hashed so the todo
// file's own key is short and stable regardless of how long the evidence
// text is.
export function fingerprintOf(v: { rule: string; path: string; evidence: string }): string {
  return createHash("sha256").update(`${v.rule}\n${v.path}\n${v.evidence}`).digest("hex").slice(0, 12);
}

export function todoPath(moduleDir: string): string {
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
