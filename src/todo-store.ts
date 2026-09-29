// Responsibility: the on-disk shape of the project's one frozen-violation
// file (archstrict.todo.json, at the project root) and the identity
// (fingerprint) that ties a todo entry to a violation across runs. Shared
// by check.ts (suppresses a violation whose fingerprint is already frozen,
// and flags a todo entry that matches nothing as stale) and todo.ts
// (writes the file) so neither has to depend on the other - both depend
// on this instead.
// Boundary: file I/O, the single-file shape, and the fingerprint's own
// definition only. No rule logic, no freeze/prune policy (that's todo.ts's
// job), no migration policy (that's todo-migration.ts's job, kept out of
// this file so it can be deleted whole after the first release).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import ts from "typescript";
import { REFERENCED_BY_MARKER } from "./type-leak.js";
import { ReportError } from "./report-error.js";
import { toProjectRelativePosix } from "./module-graph.js";
import type { ProjectRelativePath } from "./project-path.js";

export type TodoEntry = {
  rule: string;
  path: string;
  evidence: string;
  // public-surface-bypass's own identity fields (see Violation's own
  // comment in rules/public-surface.ts) - undefined on an entry migrated
  // from before this field existed. findMatchingEntry's own comment covers
  // how an entry missing these still matches a live violation.
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
// excluded. Hashed so a sortable, stable key is short regardless of how
// long the evidence text is - buildTodoIndex's own comment covers why
// matching itself never trusts a stored string.
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

// `path`/`target` MUST be project-relative before either reaches
// fingerprintOf - never the raw, absolute form a live violation's own
// `path`/`target` field actually holds. An absolute path is machine- and
// checkout-specific (a different clone, a different CI runner, even the
// same machine's own `/tmp` vs `/private/tmp`), so baking one into a key
// that gets compared across process runs - the whole point of a todo file
// - would silently stop matching the moment either side ran somewhere
// else. Every caller (todo.ts's freeze/prune, check.ts's own matching,
// simulate.ts's and fix.ts's live-vs-live diffing) relativizes through
// this one function rather than repeating the "only if target is present"
// check inline.
export function relativizeForTodo<T extends ViolationForTodo>(v: T, relativePath: ProjectRelativePath): T {
  return v.target === undefined
    ? { ...v, path: relativePath(v.path) }
    : { ...v, path: relativePath(v.path), target: relativePath(v.target) };
}

// public-surface-bypass's own evidence names the target module and
// whether THAT module has a surface - true facts, but ones that read
// differently the moment this bypass's own target module gains or loses
// a surface (or its own `surface` config changes), even though the edge
// itself (which file imports which file, through which specifier) never
// moved. specifier/target are edge-intrinsic instead: the same import
// into the same resolved file is the same debt regardless of what
// evidence's own sentence says today. Returns undefined for a rule this
// doesn't apply to, or for an entry migrated from before these fields
// existed (readTodoFile never invents them).
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
// project, and check.ts already reads the whole file only once per run
// for the same reason (see readTodoFile's own caller). `byLegacyBypassKey`
// covers only a legacy public-surface-bypass entry (no stored
// `specifier`): its (path, specifier) is parsed from evidence once, here,
// not once per violation checked against it.
export type TodoIndex = {
  byFingerprint: ReadonlyMap<string, TodoEntry>;
  byLegacyBypassKey: ReadonlyMap<string, TodoEntry>;
};

export function buildTodoIndex(entries: readonly TodoEntry[]): TodoIndex {
  const byFingerprint = new Map<string, TodoEntry>();
  const byLegacyBypassKey = new Map<string, TodoEntry>();
  for (const entry of entries) {
    // Keyed by a FRESH recompute from the entry's own stored fields
    // (already project-relative - readTodoFile normalizes a legacy
    // absolute one before this ever runs), never by a stored fingerprint
    // string: this file's own entries carry no such field at all - a
    // stored copy could only ever drift from what matching actually needs
    // (today's recompute), and a reader wanting to name an entry uses its
    // own line in the file (ParsedTodoFile.entryLocation) instead. A value
    // read from an entry migrated off the old per-module layout would
    // anyway be a hash of whatever formula was current when it was
    // frozen, not today's. A rule whose formula hasn't changed recomputes
    // to the exact same value it always had; a rule whose formula changed
    // (type-leak's own path exclusion, tag-order's own sequence-display
    // exclusion) recomputes to the value it always should have had, with
    // no rule-specific migration needed at all - stableEvidence is a pure
    // function of the evidence text alone, unaffected by which archstrict
    // version produced it. Only public-surface-bypass has a real
    // pre-migration format (no stored specifier/target at all, not just a
    // different formula over the same fields), which is what
    // byLegacyBypassKey is for.
    byFingerprint.set(fingerprintOf(entry), entry);
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
// rule, recomputed identically on both sides - see buildTodoIndex's own
// comment), falling back to the legacy (path, specifier) index only for a
// public-surface-bypass violation, since that's the only rule with a
// recorded pre-migration format at all. `relativePath` puts `v`'s own
// (absolute) path/target into the same project-relative form entries are
// always stored in, for BOTH branches - the primary lookup needs this
// exactly as much as the fallback does (fingerprintOf never relativizes
// on its own; see relativizeForTodo's own comment for why a caller must).
export function findMatchingEntry(index: TodoIndex, v: ViolationForTodo, relativePath: ProjectRelativePath): TodoEntry | undefined {
  const relativized = relativizeForTodo(v, relativePath);
  const exact = index.byFingerprint.get(fingerprintOf(relativized));
  if (exact !== undefined) return exact;
  if (relativized.rule !== "public-surface-bypass") return undefined;
  const identity = bypassIdentity(relativized);
  if (identity === undefined) return undefined;
  return index.byLegacyBypassKey.get(`${relativized.path}\n${identity.specifier}`);
}

// Builds the on-disk row for a live violation: `path`/`target` relativized,
// and specifier/target included only when the violation itself carries
// them (public-surface-bypass). No stored fingerprint (see writeTodoFile's
// own comment) - a reader that wants one recomputes it with fingerprintOf.
// Used both to freeze a brand-new entry and to refresh one that survived
// pruning, so an entry is always in the current format after either verb
// runs over it, not just at first freeze.
export function buildTodoEntry(v: ViolationForTodo, relativePath: ProjectRelativePath): TodoEntry {
  const relativized = relativizeForTodo(v, relativePath);
  const base = { rule: relativized.rule, path: relativized.path, evidence: relativized.evidence };
  return relativized.specifier !== undefined && relativized.target !== undefined
    ? { ...base, specifier: relativized.specifier, target: relativized.target }
    : base;
}

export const TODO_FILE_NAME = "archstrict.todo.json";

// Bumped only if this shape itself ever changes again - readTodoFile
// refuses a file stamped with a version it doesn't recognize (a newer
// archstrict wrote it, or a hand edit changed the number) rather than
// silently misreading it.
export const TODO_SCHEMA_VERSION = 1;

export function todoFilePath(projectRoot: string): string {
  return join(projectRoot, TODO_FILE_NAME);
}

export type TodoFileLocation = { line: number; column: number };

// One parse of archstrict.todo.json, keeping each entry's own real
// position in the file text alongside its parsed fields - stale-todo and
// clean-module-has-todo point a reader at the exact line of the entry (or
// module key) they're about, not just "somewhere in this file", the same
// as every other rule's own path:line:col. Positions come from
// TypeScript's own JSON parser (ts.parseJsonText), not from re-deriving
// them against this module's own canonical serialization: a file merged
// from two branches, or hand-edited, is still valid JSON but is no longer
// necessarily in writeTodoFile's own canonical layout, and a position
// derived from re-serializing it would silently point at the wrong line.
export type ParsedTodoFile = {
  schemaVersion: number;
  // The file's own path - every stale-todo/clean-module-has-todo
  // violation's own `path` field, so a reader lands on this file, not on
  // a module directory that has nothing to open.
  path: string;
  // Insertion order is whatever the file's own "modules" object had -
  // callers that need a stable order sort it themselves (todo.ts and
  // check.ts both iterate graph.modules, not this map, for that reason).
  modules: ReadonlyMap<string, TodoEntry[]>;
  moduleKeyLocation: ReadonlyMap<string, TodoFileLocation>;
  // Keyed by a parsed entry's own object identity: two entries with
  // identical fields (a real, if unusual, duplicate) still parse to two
  // distinct objects here, so each keeps its own location instead of
  // collapsing onto whichever one a content-keyed map kept last.
  entryLocation: ReadonlyMap<TodoEntry, TodoFileLocation>;
};

function propertyKeyName(name: ts.PropertyName): string | undefined {
  return ts.isStringLiteral(name) || ts.isIdentifier(name) ? name.text : undefined;
}

function locationOf(source: ts.JsonSourceFile, pos: number): TodoFileLocation {
  const { line, character } = source.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

const ENTRY_STRING_FIELDS = ["rule", "path", "evidence", "specifier", "target"] as const;

// `projectRoot`, when given, normalizes a raw absolute `path`/`target`
// (a hand-written fixture, or a file from before entries were always
// stored relative) into the project-relative POSIX form buildTodoEntry
// always writes today - the same normalization the pre-single-file
// readTodo already applied on every read, kept here so a caller never has
// to special-case an absolute entry itself.
function entryFromObjectLiteral(el: ts.ObjectLiteralExpression, projectRoot: string | undefined): TodoEntry | undefined {
  const fields: Record<string, string> = {};
  for (const prop of el.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyKeyName(prop.name);
    if (key === undefined || !ts.isStringLiteral(prop.initializer)) continue;
    if ((ENTRY_STRING_FIELDS as readonly string[]).includes(key)) fields[key] = prop.initializer.text;
  }
  if (fields.rule === undefined || fields.path === undefined || fields.evidence === undefined) return undefined;
  const path = projectRoot !== undefined && isAbsolute(fields.path) ? toProjectRelativePosix(fields.path, projectRoot) : fields.path;
  const entry: TodoEntry = { rule: fields.rule, path, evidence: fields.evidence };
  if (fields.specifier !== undefined && fields.target !== undefined) {
    // `specifier` is an import specifier, never a filesystem path - no
    // normalization applies to it.
    entry.specifier = fields.specifier;
    entry.target = projectRoot !== undefined && isAbsolute(fields.target)
      ? toProjectRelativePosix(fields.target, projectRoot)
      : fields.target;
  }
  return entry;
}

function malformed(path: string): ReportError {
  return new ReportError(
    `${path}: not a valid archstrict.todo.json (expected { schemaVersion, modules })`,
    "restore it from version control, or delete it and run archstrict todo to regenerate it",
  );
}

// Parses archstrict.todo.json's own text directly (not JSON.parse, which
// would give back plain values with no position information at all) -
// exported so a Hegel round-trip test can feed writeTodoFile's own output
// straight back in without going through the filesystem.
export function parseTodoFileText(path: string, text: string, projectRoot?: string): ParsedTodoFile {
  const source = ts.parseJsonText(path, text);
  const root = (source.statements[0] as ts.ExpressionStatement | undefined)?.expression;
  if (root === undefined || !ts.isObjectLiteralExpression(root)) throw malformed(path);

  let schemaVersion: number | undefined;
  const modules = new Map<string, TodoEntry[]>();
  const moduleKeyLocation = new Map<string, TodoFileLocation>();
  const entryLocation = new Map<TodoEntry, TodoFileLocation>();

  for (const prop of root.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyKeyName(prop.name);
    if (key === "schemaVersion" && ts.isNumericLiteral(prop.initializer)) {
      schemaVersion = Number(prop.initializer.text);
    } else if (key === "modules" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const moduleProp of prop.initializer.properties) {
        if (!ts.isPropertyAssignment(moduleProp)) continue;
        const name = propertyKeyName(moduleProp.name);
        if (name === undefined) continue;
        moduleKeyLocation.set(name, locationOf(source, moduleProp.name.getStart(source)));
        const entries: TodoEntry[] = [];
        if (ts.isArrayLiteralExpression(moduleProp.initializer)) {
          for (const el of moduleProp.initializer.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const entry = entryFromObjectLiteral(el, projectRoot);
            if (entry === undefined) continue;
            entries.push(entry);
            entryLocation.set(entry, locationOf(source, el.getStart(source)));
          }
        }
        modules.set(name, entries);
      }
    }
  }
  if (schemaVersion === undefined) throw malformed(path);
  if (schemaVersion !== TODO_SCHEMA_VERSION) {
    throw new ReportError(
      `${path}: schemaVersion ${schemaVersion} is not supported (archstrict writes ${TODO_SCHEMA_VERSION})`,
      "upgrade archstrict, or delete the file and run archstrict todo to regenerate it",
    );
  }
  return { schemaVersion, path, modules, moduleKeyLocation, entryLocation };
}

export function readTodoFile(projectRoot: string): ParsedTodoFile | undefined {
  const p = todoFilePath(projectRoot);
  if (!existsSync(p)) return undefined;
  const text = readFileSync(p, "utf8");
  // JSON.parse first, ahead of ts.parseJsonText (used below only for
  // positions): ts.parseJsonText recovers from a syntax error by parsing
  // whatever prefix it can and returning the rest as an error node, rather
  // than throwing - exactly the shape an unresolved git merge conflict
  // marker or a truncated write leaves behind. Silently reading a partial
  // parse would make `todo` write back only the entries that happened to
  // survive the truncation, discarding the rest - the one failure mode
  // this whole layout (one entry per line, so a genuine three-way merge
  // resolves cleanly) exists to avoid. JSON.parse rejects that same input
  // outright, so a real syntax error surfaces as a ReportError instead of
  // silent data loss.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw malformed(p);
  }
  // Undefined (not thrown) ONLY for the one shape a legacy file at this
  // exact path can actually have: { entries: [...] }, no schemaVersion at
  // all - a module whose own glob covers the project root itself (e.g.
  // "**") has its legacy per-module path equal to this new file's own
  // path (todo-store.ts's own todoFilePath and todo-migration.ts's own
  // legacy path collide there). The caller (todo.ts, check.ts's own
  // readCurrentTodo) then falls back to todo-migration.ts's own reader,
  // which recognizes that shape. Anything else missing schemaVersion - a
  // hand-edited `{ "modules": {...} }` that lost its version, a bare `{}`,
  // any other malformed object - is NOT silently read as "absent": that
  // would make the next `todo` run treat it as a genuine first run and
  // overwrite it, discarding whatever was really there.
  if (
    typeof raw === "object" && raw !== null && !("schemaVersion" in raw)
    && Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw)) throw malformed(p);
  return parseTodoFileText(p, text, projectRoot);
}

// Plain code-unit order, never String.prototype.localeCompare: locale
// collation (accents, case, punctuation folding) depends on the ICU data
// installed on whichever machine runs `archstrict todo`, so two
// developers on two locales could write two different byte orderings for
// the identical entry set - defeating the whole point of a canonical,
// diffable serialization.
function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeEntry(entry: TodoEntry): string {
  const ordered: TodoEntry = entry.specifier !== undefined && entry.target !== undefined
    ? { rule: entry.rule, path: entry.path, evidence: entry.evidence, specifier: entry.specifier, target: entry.target }
    : { rule: entry.rule, path: entry.path, evidence: entry.evidence };
  return JSON.stringify(ordered);
}

// The sort that makes two branches touching different modules produce a
// text diff confined to those modules' own blocks, and two branches that
// each delete a different entry from the SAME module merge cleanly (each
// entry is its own line - deleting one line in each branch is an ordinary
// three-way text merge, not a JSON-structural one): module names in
// order, then within a module, entries by path, then rule, then
// fingerprint (the same identity fingerprintOf already gives every entry,
// reused here purely as a deterministic tiebreak - two entries that share
// path AND rule but differ in specifier/target, e.g. two distinct
// public-surface-bypass edges into the same target from the same importer
// via two different specifiers, would otherwise sort in whatever order
// they happened to arrive in), then the entry's own serialized line as a
// final tiebreak (two type-leak entries can share path, rule, AND
// fingerprint while differing only in evidence's own mutable
// "referenced by" suffix - stableEvidence strips that suffix before
// hashing, so it never enters the fingerprint at all).
function sortedEntries(entries: readonly TodoEntry[]): TodoEntry[] {
  return [...entries].sort((a, b) => {
    return codeUnitCompare(a.path, b.path)
      || codeUnitCompare(a.rule, b.rule)
      || codeUnitCompare(fingerprintOf(a), fingerprintOf(b))
      || codeUnitCompare(serializeEntry(a), serializeEntry(b));
  });
}

// Hand-built, not JSON.stringify(file, null, 2): stringify's own pretty
// printer wraps one entry object across several lines, which would make a
// single added or removed field inside one entry look, to a line-based
// diff/merge, like it touched every entry after it in the same array.
// One compact JSON object per line keeps a diff (and a merge) confined to
// exactly the lines that changed.
export function serializeTodoFile(modulesByName: ReadonlyMap<string, readonly TodoEntry[]>): string {
  const names = [...modulesByName.keys()]
    .filter((name) => (modulesByName.get(name)?.length ?? 0) > 0)
    .sort(codeUnitCompare);
  const lines: string[] = ["{", `  "schemaVersion": ${TODO_SCHEMA_VERSION},`, '  "modules": {'];
  names.forEach((name, moduleIndex) => {
    const entries = sortedEntries(modulesByName.get(name) ?? []);
    lines.push(`    ${JSON.stringify(name)}: [`);
    entries.forEach((entry, entryIndex) => {
      lines.push(`      ${serializeEntry(entry)}${entryIndex < entries.length - 1 ? "," : ""}`);
    });
    lines.push(`    ]${moduleIndex < names.length - 1 ? "," : ""}`);
  });
  lines.push("  }", "}");
  return lines.join("\n") + "\n";
}

// Always writes the file, even with an empty module map (a project with
// no debt after its first run still gets one, so the ratchet's own state
// - "todo has run" - stays visible on disk instead of looking identical
// to "todo has never run"). Never deletes it: unlike the old per-module
// file (which vanished the moment a module's own debt hit zero),
// existence of the single root file IS the "first run happened" signal
// now - see todo.ts's own firstRun check, which replaces the old
// `.archstrict-todo-initialized` marker with this file's own existence.
export function writeTodoFile(projectRoot: string, modulesByName: ReadonlyMap<string, readonly TodoEntry[]>): void {
  writeFileSync(todoFilePath(projectRoot), serializeTodoFile(modulesByName));
}
