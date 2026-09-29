// Responsibility: turn a list of analyzed files into the groups init
// declares as modules - one directory group per top-level (or per-container)
// directory that holds an analyzed file, one file group per loose file -
// plus the on-disk naming rule for each group and the literal
// declaredModules-entry text init pastes into the generated config. The
// same grouping and naming also produces the paste-ready suggestion for a
// file an EXISTING config doesn't cover yet (rule 3's own `do:`, `archstrict
// rules <path>`, and init's re-run listing all share `suggestUncovered`
// below, so the three can never drift into different phrasings of the same
// entry).
// Boundary: no I/O, and no opinion about WHICH files are analyzed - the
// caller (init's own walk, or a config-vs-graph consistency check) already
// decided that and hands this module the resulting file list, anchor set,
// and the config's own declaredModules (for the `taken`-name check).
import { moduleGlobBaseDir, moduleGlobList } from "./module-graph.js";

// A file's project-relative path, POSIX-separated - the same shape
// module-graph.ts's toProjectRelativePosix produces.
export type CandidateGroup = {
  kind: "file" | "dir";
  // The group's own project-relative path: a directory's path for a "dir"
  // group, or the file's own path for a "file" group.
  rel: string;
  // The anchor (project-relative directory, "" for the project root) this
  // group was found directly under.
  anchor: string;
  // The on-disk name alone (no path): a directory's own name, or a file's
  // name including its extension.
  onDiskName: string;
  // How many analyzed files this group covers - 1 for a file group,
  // otherwise every analyzed file under the directory.
  fileCount: number;
};

export type DeclaredModuleEntry = { name: string; glob: string; surface?: string };

export type NamedCandidateGroup = CandidateGroup & {
  entry: DeclaredModuleEntry;
  // The glob to add to `exclude` instead, when a group turns out not to be
  // module content - the same glob as entry.glob, restated: a directory
  // group's entry.glob and its exclude equivalent are identical strings,
  // but the two fields exist so a caller never has to reach into `entry`
  // to build the "or exclude" half of a suggestion.
  excludeGlob: string;
};

const byteSort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Groups analyzed files by their nearest anchor: for a file `f`, the
// longest anchor that contains it. A file sitting directly in its anchor is
// its own group (a file group); otherwise the group is the first directory
// below the anchor on the path to `f` (a directory group) - so a deeply
// nested file (`src/runtime/db/pool.ts`) still groups under `src/runtime`,
// one entry per top-level directory, not one per leaf.
export function groupAnalyzedFiles(files: readonly string[], anchors: readonly string[]): CandidateGroup[] {
  const sortedAnchors = [...anchors].sort((a, b) => b.length - a.length);
  const groups = new Map<string, CandidateGroup>();
  for (const file of files) {
    // "" is always the last (shortest) anchor tried, and always matches -
    // every analyzed file is under the project root - so this always finds one.
    const anchor = sortedAnchors.find((a) => a === "" || file.startsWith(`${a}/`))!;
    const rest = anchor === "" ? file : file.slice(anchor.length + 1);
    const [first, ...more] = rest.split("/") as [string, ...string[]];
    const rel = anchor === "" ? first : `${anchor}/${first}`;
    const kind: CandidateGroup["kind"] = more.length === 0 ? "file" : "dir";
    const existing = groups.get(rel);
    if (existing !== undefined) {
      existing.fileCount++;
      continue;
    }
    groups.set(rel, { kind, rel, anchor, onDiskName: first, fileCount: 1 });
  }
  return [...groups.values()].sort((a, b) => byteSort(a.rel, b.rel));
}

// Naming, three cases: (1) a group's name is its on-disk name, unless that
// name collides with another group's own on-disk name at the SAME anchor
// depth - one directory cannot hold a file and a directory of the same
// name, so a top-level `cli.ts` and a `src/cli.ts` never collide with each
// other directly, only through rule 2; (2) a group below the project root
// whose on-disk name is already `taken` (by an existing config entry, or by
// another group sharing that name) instead takes its own project-relative
// path as its name; (3) a project-root group (anchor "") has no deeper
// path to fall back to - its on-disk name IS its rel - so a root name still
// `taken` after that takes a "./"-prefixed rel instead (measured: pasting
// `{ name: "./tools", glob: "tools/**" }` next to an existing "tools" gave
// 0 violations and tsc passed). This only fires for a re-run's or rule 3's
// suggestion - a fresh init never has a `taken` set with anything a fresh
// root group's own on-disk name could collide with.
export function nameCandidates(
  groups: readonly CandidateGroup[],
  taken: ReadonlySet<string>,
): NamedCandidateGroup[] {
  const onDiskCounts = new Map<string, number>();
  for (const g of groups) onDiskCounts.set(g.onDiskName, (onDiskCounts.get(g.onDiskName) ?? 0) + 1);

  return groups.map((g): NamedCandidateGroup => {
    const collides = taken.has(g.onDiskName) || (g.anchor !== "" && (onDiskCounts.get(g.onDiskName) ?? 0) > 1);
    const name = g.anchor === "" ? (collides ? `./${g.rel}` : g.onDiskName) : collides ? g.rel : g.onDiskName;
    const glob = g.kind === "dir" ? `${g.rel}/**` : g.rel;
    const entry: DeclaredModuleEntry =
      g.kind === "dir" ? { name, glob } : { name, glob, surface: g.onDiskName };
    return { ...g, entry, excludeGlob: glob };
  });
}

const q = JSON.stringify;

// The literal declaredModules[] entry text init pastes into the generated
// config, and the same text a later suggestion (for the root-name-collision
// case above) would paste for an uncovered path - kept as one function so
// the two can never drift into two different phrasings of the same entry
// shape. A directory entry carries no `surface` of its own (the top-level
// default, or the directory's own package.json exports map, applies
// instead) - a file
// entry always does, naming the file itself, since a file with no surface
// of its own would otherwise be entirely private (nothing else could ever
// export from it).
export function declaredModuleEntryText(entry: DeclaredModuleEntry): string {
  return entry.surface === undefined
    ? `{ name: ${q(entry.name)}, glob: ${q(entry.glob)} }`
    : `{ name: ${q(entry.name)}, glob: ${q(entry.glob)}, surface: ${q(entry.surface)} }`;
}

// The one shared entry point rule 3, `archstrict rules <path>`, and init's
// re-run all call: given the project-relative paths of files an EXISTING
// config's declaredModules doesn't cover, group and name them exactly as a
// fresh init would, with the config's own declaredModules entries counted
// as `taken` names. Anchors are the project root plus the parent directory
// of each existing entry's own glob base - the same depth a fresh init
// itself would have grouped that entry at, computed by string ops alone
// (moduleGlobBaseDir strips the glob down to its literal prefix; only
// that prefix's parent directory is the anchor, and a file list
// contributes one anchor per path).
export function suggestUncovered(
  uncoveredRelFiles: readonly string[],
  declaredModules: readonly { name: string; glob: string | readonly string[] }[],
): NamedCandidateGroup[] {
  const anchors = new Set<string>([""]);
  for (const dm of declaredModules) {
    // The parent of each glob's literal base, the same depth a fresh init
    // groups at. A directory glob `src/app/**` anchors at `src`, so a
    // sibling directory is its own group. A file glob `src/sqlite.ts`
    // anchors at `src`, so the file itself is a file group. A file list
    // anchors at the shared directory, once per path.
    for (const glob of moduleGlobList(dm.glob)) {
      const base = moduleGlobBaseDir(glob);
      const slash = base.lastIndexOf("/");
      anchors.add(slash === -1 ? "" : base.slice(0, slash));
    }
  }
  const taken = new Set(declaredModules.map((dm) => dm.name));
  return nameCandidates(groupAnalyzedFiles(uncoveredRelFiles, [...anchors]), taken);
}

// Which of `suggestUncovered`'s own groups a single project-relative file
// belongs to - a file group's own `rel` IS the file, a directory group's
// `rel` is its own directory, so the file sits somewhere below it.
export function groupForRelFile(rel: string, groups: readonly NamedCandidateGroup[]): NamedCandidateGroup | undefined {
  return groups.find((g) => g.rel === rel || rel.startsWith(`${g.rel}/`));
}

// The one sentence rule 3's `do:` and `archstrict rules <path>` both print
// for a single uncovered file - the paste-ready entry, with the exclude
// alternative right beside it so the same suggestion never leads an agent
// to add a directory entry for a file that turns out not to be module
// content at all.
export function suggestionDoText(group: NamedCandidateGroup): string {
  return `add ${declaredModuleEntryText(group.entry)} to declaredModules in archstrict.config.ts, or add ${q(group.excludeGlob)} to exclude if it is not module content; then run archstrict init`;
}
