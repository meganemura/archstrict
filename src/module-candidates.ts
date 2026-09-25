// Responsibility: turn a list of analyzed files into the groups init
// declares as modules - one directory group per top-level (or per-container)
// directory that holds an analyzed file, one file group per loose file -
// plus the on-disk naming rule for each group and the literal
// declaredModules-entry text init pastes into the generated config.
// Boundary: no I/O, and no opinion about WHICH files are analyzed - the
// caller (init's own walk today; a config-vs-graph consistency check,
// later) already decided that and hands this module the resulting file
// list and anchor set.
//
// One naming case stays unimplemented: a project-root group (anchor "")
// whose on-disk name an existing config's declaredModules already uses
// (passed in as `taken`) still takes that plain on-disk name today,
// because root groups never consult `taken` - only a deeper group's own
// rel-path fallback does. A "./"-prefixed path would be the fix, but
// nothing calls nameCandidates with a non-empty `taken` yet (init always
// starts from a fresh config), so there is no real case to verify against.
// A later caller that suggests an entry for a file an existing config
// doesn't cover yet can extend nameCandidates without reshaping its return
// value.

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

// Naming, two cases (a third stays out of scope - see this file's own
// header comment): (1) a group's name is its on-disk name, unless that name
// collides with another group's own on-disk name at the SAME anchor depth -
// one directory cannot hold a file and a directory of the same name, so a
// top-level `cli.ts` and a `src/cli.ts` never collide with each other
// directly, only through rule 2; (2) a group below the project root whose
// on-disk name is already `taken` (by an existing config entry, or by
// another group sharing that name) instead takes its own project-relative
// path as its name.
export function nameCandidates(
  groups: readonly CandidateGroup[],
  taken: ReadonlySet<string>,
): NamedCandidateGroup[] {
  const onDiskCounts = new Map<string, number>();
  for (const g of groups) onDiskCounts.set(g.onDiskName, (onDiskCounts.get(g.onDiskName) ?? 0) + 1);

  return groups.map((g): NamedCandidateGroup => {
    const collides = taken.has(g.onDiskName) || (g.anchor !== "" && (onDiskCounts.get(g.onDiskName) ?? 0) > 1);
    const name = g.anchor === "" ? g.onDiskName : collides ? g.rel : g.onDiskName;
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
