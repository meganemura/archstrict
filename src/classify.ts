// Responsibility: turn a config's `classify` (glob -> tags) and
// `classifyByDirectoryName` (ambient, name-based) entries into the tag set a
// given file carries. Boundary: no edge-constraint logic here (that's
// tickets 4+); this module only answers "what tags does this file have."
//
// Precedence for two `classify` entries that both match the same file:
// most-specific wins, where specificity is (a) the glob's literal prefix
// length (the text before its first wildcard character), then (b) fewest
// wildcard characters. This makes config order irrelevant - the property a
// coding agent depends on when it can't see how a config it's editing was
// originally ordered. A tie (identical specificity, different tags) is a
// config error: two equally-specific entries disagreeing about the same
// file is not something precedence can resolve for you.
//
// `classify` and `classifyByDirectoryName` are independent mechanisms whose
// results union: a file can get tags from an explicit glob AND an ambient
// directory-name match at once (VS Code's own env:* tags are pure ambient;
// Prisma's are pure explicit; nothing requires a project pick only one).
import { sep } from "node:path";
import { ReportError } from "./report-error.js";

export type ClassifyEntry = { glob: string; tags: readonly string[] };
export type ClassifyByDirectoryName = { tagNamespace: string; names: readonly string[] };

// Converts one glob into a matcher plus its specificity. Supports `**`
// (any number of path segments, including zero) and `*` (any characters
// within one path segment - no `/`). Anything else in the pattern is a
// literal character, escaped for use in a RegExp. Exported: declared-module
// membership (module-graph.ts) uses the same precedence rule as tag
// classification does, and shouldn't reimplement it.
export function compileGlob(glob: string): { test: (path: string) => boolean; literalPrefixLength: number; wildcardCount: number } {
  const firstWildcard = glob.search(/\*/);
  const literalPrefixLength = firstWildcard === -1 ? glob.length : firstWildcard;
  const wildcardCount = (glob.match(/\*/g) ?? []).length;

  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("/**/", i)) {
      // `a/**/b.ts` must match `a/b.ts` too (zero segments between the two
      // literal slashes), not just `a/x/b.ts` - translating `**` to `.*` in
      // isolation while keeping both surrounding slashes as literals would
      // require at least one segment. Fold the trailing slash into an
      // optional group instead: one literal slash, then an optional
      // "anything, ending in a slash" group.
      pattern += "/(?:.*/)?";
      i += 4;
    } else if (glob.startsWith("**", i)) {
      pattern += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      pattern += "[^/]*";
      i += 1;
    } else {
      pattern += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const re = new RegExp(`^${pattern}$`);
  return { test: (path: string) => re.test(path), literalPrefixLength, wildcardCount };
}

// A path is more specific than another when its literal prefix is longer,
// or (tied) it has fewer wildcards. Returns 0 for a genuine tie: same
// literal-prefix length AND same wildcard count - the config-error case.
function compareSpecificity(
  a: { literalPrefixLength: number; wildcardCount: number },
  b: { literalPrefixLength: number; wildcardCount: number },
): number {
  if (a.literalPrefixLength !== b.literalPrefixLength) {
    return a.literalPrefixLength - b.literalPrefixLength;
  }
  return b.wildcardCount - a.wildcardCount; // fewer wildcards = more specific
}

export class AmbiguousClassifyError extends ReportError {
  constructor(path: string, glob1: string, glob2: string) {
    super(
      `'${path}' matches two equally-specific entries ('${glob1}' and '${glob2}') with no way to prefer one - narrow one of the globs`,
      `narrow '${glob1}' or '${glob2}' in archstrict.config.ts, then run archstrict check`,
    );
    this.name = "AmbiguousClassifyError";
  }
}

// Shared precedence engine: the most-specific of several glob-keyed entries
// matching `path` wins, config order is irrelevant, and a genuine tie
// (equal specificity, different `value`s per `sameValue`) throws. Used both
// for tag classification (`value` is a tag array) and declared-module
// membership (`value` is a module name) - two different callers, one
// precedence rule, so they can't quietly drift apart.
export function mostSpecificMatch<T>(
  path: string,
  entries: readonly { glob: string; value: T }[],
  sameValue: (a: T, b: T) => boolean,
): T | undefined {
  let best: { value: T; glob: string; literalPrefixLength: number; wildcardCount: number } | undefined;
  for (const entry of entries) {
    const compiled = compileGlob(entry.glob);
    if (!compiled.test(path)) continue;
    if (best === undefined) {
      best = { value: entry.value, glob: entry.glob, ...compiled };
      continue;
    }
    const cmp = compareSpecificity(compiled, best);
    if (cmp > 0) {
      best = { value: entry.value, glob: entry.glob, ...compiled };
    } else if (cmp === 0 && !sameValue(entry.value, best.value)) {
      throw new AmbiguousClassifyError(path, best.glob, entry.glob);
    }
  }
  return best?.value;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

// Relative path (project-root-relative, forward-slash-separated) -> the
// tags its most-specific matching `classify` entry names, or undefined if
// no entry matches at all.
export function classifyByGlob(
  path: string,
  entries: readonly ClassifyEntry[],
): readonly string[] | undefined {
  return mostSpecificMatch(
    path,
    entries.map((e) => ({ glob: e.glob, value: e.tags })),
    sameTags,
  );
}

// The nearest directory-name segment (innermost first) matching one of
// `names` becomes `${tagNamespace}:${name}` - VS Code's own code-layering.ts
// algorithm: walk the path's directory segments from the file outward, stop
// at the first recognized name.
export function classifyByDirectoryName(
  path: string,
  config: ClassifyByDirectoryName | undefined,
): readonly string[] {
  if (config === undefined) return [];
  const segments = path.split(sep === "\\" ? /\\|\// : "/");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (config.names.includes(segments[i]!)) {
      return [`${config.tagNamespace}:${segments[i]}`];
    }
  }
  return [];
}

export function classifyFile(
  path: string,
  config: { classify?: readonly ClassifyEntry[]; classifyByDirectoryName?: ClassifyByDirectoryName },
): Set<string> {
  const tags = new Set<string>();
  for (const tag of classifyByGlob(path, config.classify ?? []) ?? []) tags.add(tag);
  for (const tag of classifyByDirectoryName(path, config.classifyByDirectoryName)) tags.add(tag);
  return tags;
}
