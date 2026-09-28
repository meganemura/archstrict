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
import { basename, dirname, isAbsolute, join } from "node:path";
import { REFERENCED_BY_MARKER } from "./rules/type-leak.js";
import { toProjectRelativePosix } from "./module-graph.js";
import type { ProjectRelativePath } from "./project-path.js";

export type TodoEntry = {
  fingerprint: string;
  rule: string;
  path: string;
  evidence: string;
  // public-surface-bypass's own identity fields (see Violation's own
  // comment in rules/public-surface.ts) - undefined on an entry frozen
  // before this field existed. entryMatches's own comment covers how an
  // entry missing these still matches a live violation.
  specifier?: string;
  target?: string;
};

// Identity for a violation across runs: rule, importing path, and the
// evidence text — no line number (a line moving is not a new violation;
// archspec's own fingerprint makes the same choice). Three rules replace
// `path` and/or `evidence` with something narrower, each because the
// literal field can change for a reason that has nothing to do with
// whether the underlying debt is still the same edge:
//
// "cycle": `path` is `firstEdge.fromFile` — the file of one arbitrary edge
// in the cycle, an implementation detail of which edge the shortest-path
// search happened to return first, not the cycle's own identity. The
// cycle itself (`evidence`, e.g. "a -> b -> c -> a") is the identity; if
// that one file moved but the same cycle still existed, including `path`
// would change the fingerprint and the frozen entry would go stale for a
// cycle that never actually changed.
//
// "type-leak": `path` is the surface file whose declaration site sorts
// earliest among however many surface files the leak's own module has -
// an accident of which surface file a later one happens to be added
// alongside, not part of the leak's own identity (module, internal type,
// and its declaring file already fully identify it, and all three appear
// in evidence's own stable prefix - see stableEvidence below). A module
// moving from one surface file to two, with the second sorting earlier,
// would otherwise re-anchor `path` and stale an unrelated, still-real leak.
//
// Every other rule's `path` names the real thing the violation is about
// (the importing file, or the config file), so only these two are
// excluded. Hashed so the todo file's own key is short and stable
// regardless of how long the evidence text is.
//
// `stableEvidence` additionally strips a rule's own known-mutable slice of
// `evidence` before it's hashed, for two rules:
//
// - "type-leak": evidence embeds a mutable, informational list of every
//   exported symbol CURRENTLY referencing a leaked internal type, after
//   REFERENCED_BY_MARKER - not part of the leak's own identity. Without
//   stripping it, one more real caller of an already-frozen leak appearing
//   would change the fingerprint and reopen a frozen entry for a leak that
//   hasn't newly appeared - measured directly: freezing a leak referenced
//   by one export, then adding a second real export referencing the same
//   internal type, produced both a stale-todo violation for the old entry
//   and a fresh, unfrozen one for what is still the same leak.
// - "tag-order": evidence embeds the full configured sequence
//   (`(<namespace> sequence: a -> b -> c)`) purely to explain why the edge
//   is forbidden - a value added anywhere in that sequence, even one this
//   edge's own two layers never touch, changes the text without changing
//   which edge is forbidden or why. Stripped back to the sentence naming
//   the specifier and the two real layers it connects.
//
// A fourth rule, public-surface-bypass, doesn't fit this "trim the
// evidence" shape at all: its evidence names the target module and
// whether that module has a surface, and BOTH change when that one
// module (not evidence's own surrounding text) gains a surface - not a
// mutable suffix to strip, but a different sentence template entirely.
// See `bypassIdentity` below for why it keys off structured fields
// instead.
const TAG_ORDER_SEQUENCE_MARKER = " sequence: ";
function stableEvidence(rule: string, evidence: string): string {
  if (rule === "type-leak") {
    const i = evidence.indexOf(REFERENCED_BY_MARKER);
    return i === -1 ? evidence : evidence.slice(0, i);
  }
  if (rule === "tag-order") {
    // rules/constraints.ts's own template puts this clause last, wrapped
    // in one paren pair with no nested parens - trimming from the LAST
    // "(" before the marker keeps `sourceLayer -> targetLayer` (still text
    // before the marker) intact while dropping only the sequence list.
    const markerAt = evidence.indexOf(TAG_ORDER_SEQUENCE_MARKER);
    if (markerAt === -1) return evidence;
    const openParenAt = evidence.lastIndexOf("(", markerAt);
    return openParenAt === -1 ? evidence : evidence.slice(0, openParenAt).trimEnd();
  }
  return evidence;
}

function pathExcludedFromKey(rule: string): boolean {
  return rule === "cycle" || rule === "type-leak";
}

export type ViolationForTodo = {
  rule: string;
  path: string;
  evidence: string;
  specifier?: string;
  target?: string;
};

// public-surface-bypass's own evidence names the target module and
// whether THAT module has a surface - true facts, but ones that read
// differently the moment this bypass's own target module gains or loses
// a surface (or its own `surface` config changes), even though the edge
// itself (which file imports which file, through which specifier) never
// moved. specifier/target are edge-intrinsic instead: the same import
// into the same resolved file is the same debt regardless of what
// evidence's own sentence says today. Returns undefined for a rule this
// doesn't apply to, or for an entry frozen before these fields existed
// (readTodo never invents them).
function bypassIdentity(v: ViolationForTodo): { specifier: string; target: string } | undefined {
  if (v.rule !== "public-surface-bypass" || v.specifier === undefined || v.target === undefined) return undefined;
  return { specifier: v.specifier, target: v.target };
}

export function fingerprintOf(v: ViolationForTodo): string {
  const identity = bypassIdentity(v);
  const key = identity !== undefined
    ? `${v.rule}\n${v.path}\n${identity.specifier}\n${identity.target}`
    : pathExcludedFromKey(v.rule)
      ? `${v.rule}\n${stableEvidence(v.rule, v.evidence)}`
      : `${v.rule}\n${v.path}\n${stableEvidence(v.rule, v.evidence)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

// Migration only: a public-surface-bypass entry frozen before specifier/
// target existed carries only the sentence violationFor built. Both of
// evidence's own sentence shapes ("resolved to module 'm', which has no
// ..." and "resolved to a file inside module 'm' other than its ...")
// start with the same quoted specifier, so a small, fixed prefix
// recovers it without knowing which shape produced this entry. This
// parse exists only for an old entry with no stored `specifier` - a
// fresh one always carries the field, and skips it entirely.
function parseSpecifierFromLegacyBypassEvidence(evidence: string): string | undefined {
  const match = /^'(.+?)' resolved to /.exec(evidence);
  return match?.[1];
}

// A module's own todo entries, indexed once so matching a violation
// against them is O(1) instead of a fresh scan (and a fresh sha256) per
// violation - a module can carry tens of thousands of entries on a large
// project, and check.ts already reads its file only once per run for the
// same reason (see readTodo's own caller). `byLegacyBypassKey` covers only
// a legacy public-surface-bypass entry (no stored `specifier`): its
// (path, specifier) is parsed from evidence once, here, not once per
// violation checked against it.
export type TodoIndex = {
  byFingerprint: ReadonlyMap<string, TodoEntry>;
  byLegacyBypassKey: ReadonlyMap<string, TodoEntry>;
};

export function buildTodoIndex(entries: readonly TodoEntry[]): TodoIndex {
  const byFingerprint = new Map<string, TodoEntry>();
  const byLegacyBypassKey = new Map<string, TodoEntry>();
  for (const entry of entries) {
    byFingerprint.set(entry.fingerprint, entry);
    if (entry.rule === "public-surface-bypass" && entry.specifier === undefined) {
      const specifier = parseSpecifierFromLegacyBypassEvidence(entry.evidence);
      if (specifier !== undefined) byLegacyBypassKey.set(`${entry.path}\n${specifier}`, entry);
    }
  }
  return { byFingerprint, byLegacyBypassKey };
}

export const EMPTY_TODO_INDEX: TodoIndex = { byFingerprint: new Map(), byLegacyBypassKey: new Map() };

// The one place check.ts/todo.ts ask "does some entry in this index still
// name this live violation" - a fingerprint lookup first (covers every
// rule, and a public-surface-bypass entry frozen under the current
// scheme), falling back to the legacy (path, specifier) index only for a
// public-surface-bypass violation, since that's the only rule with a
// recorded pre-migration format at all. `relativePath` normalizes the
// live violation's own (absolute) importer path to the same
// project-relative form entries are always stored in - needed only for
// this fallback; the primary lookup never touches path text directly (it
// was baked into the hash at freeze time, from the same live-violation
// shape being looked up now).
export function findMatchingEntry(index: TodoIndex, v: ViolationForTodo, relativePath: ProjectRelativePath): TodoEntry | undefined {
  const exact = index.byFingerprint.get(fingerprintOf(v));
  if (exact !== undefined) return exact;
  if (v.rule !== "public-surface-bypass") return undefined;
  const identity = bypassIdentity(v);
  if (identity === undefined) return undefined;
  return index.byLegacyBypassKey.get(`${relativePath(v.path)}\n${identity.specifier}`);
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

// `projectRoot`, when given, normalizes a legacy absolute `entry.path`
// (written by an older archstrict, before todo entries stored a
// project-relative path) into the same relative form a new freeze writes
// today. Guarded by `isAbsolute`: an already-relative path must never pass
// through `toProjectRelativePosix` (it wraps node:path's `relative()`,
// which treats a relative input as relative to `process.cwd()`, not
// `projectRoot`, and would silently produce a wrong result). Omitting
// `projectRoot` leaves every entry exactly as stored - existing callers
// that don't pass it keep their current behavior unchanged.
export function readTodo(moduleDir: string, projectRoot?: string): TodoEntry[] {
  const p = todoPath(moduleDir);
  if (!existsSync(p)) return [];
  const entries = (JSON.parse(readFileSync(p, "utf8")) as { entries: TodoEntry[] }).entries;
  if (projectRoot === undefined) return entries;
  return entries.map((e) => (isAbsolute(e.path) ? { ...e, path: toProjectRelativePosix(e.path, projectRoot) } : e));
}

export function writeTodo(moduleDir: string, entries: TodoEntry[]): void {
  const p = todoPath(moduleDir);
  if (entries.length === 0) {
    if (existsSync(p)) unlinkSync(p);
    return;
  }
  writeFileSync(p, JSON.stringify({ entries }, null, 2) + "\n");
}
