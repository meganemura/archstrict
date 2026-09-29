// Responsibility: decide whether a project-relative path is gitignored, by
// parsing .gitignore files and the repository's info/exclude with git's own
// pattern rules (negation, directory-only patterns, anchoring, `**`), so the
// project walk can skip scratch output that was never project source.
// Boundary: this module reads ignore files only. It never spawns git, never
// walks a directory tree (module-graph.ts's walk calls in per directory), and
// never reads the user's global core.excludesFile: that file differs from
// machine to machine, so honoring it would make a laptop and CI analyze
// different file sets from the same checkout.
//
// Parsing instead of `git ls-files --ignored` keeps the walk independent of
// git: a copy of a checkout with no .git directory, or a machine with no git
// binary, still skips what the checkout's own .gitignore files name.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// `literal` is set for an unanchored pattern with no wildcard or escape
// (`node_modules/`, `Thumbs.db`): it matches a basename exactly.
type Rule = { regex: RegExp; negate: boolean; dirOnly: boolean; literal?: string };

// One ignore file's rules, plus how to turn a project-relative path into a
// path relative to that file's own directory: `prefix + rel.slice(strip)`.
// A file above the project root gets a prefix (the project root's path from
// that file's directory); a nested file below it strips its own directory.
//
// Literal rules are indexed by name, because the walk tests every entry of
// the project against every layer: on a 13k-file tree, testing each literal
// rule as a regex made the walk about 35% slower. The maps keep the highest
// rule index per name, so "last matching rule wins" still holds.
type Layer = {
  rules: readonly Rule[];
  prefix: string;
  strip: number;
  literalAny: ReadonlyMap<string, number>;
  literalDir: ReadonlyMap<string, number>;
  patterned: readonly number[];
};

function makeLayer(rules: readonly Rule[], prefix: string, strip: number): Layer {
  const literalAny = new Map<string, number>();
  const literalDir = new Map<string, number>();
  const patterned: number[] = [];
  rules.forEach((rule, index) => {
    if (rule.literal === undefined) patterned.push(index);
    else (rule.dirOnly ? literalDir : literalAny).set(rule.literal, index);
  });
  return { rules, prefix, strip, literalAny, literalDir, patterned };
}

// Ordered from lowest to highest precedence, the same order git uses:
// info/exclude, then each .gitignore from the repository root downward.
export type GitignoreStack = readonly Layer[];

// A walk state for one path. "forced" is a path at or under a declared
// module's own base directory that gitignore would drop: the declaration is
// the project's explicit request to analyze it anyway.
export type IgnoreState = "kept" | "ignored" | "forced";

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

// One path segment (no "/") of a gitignore pattern, as a regex source.
function translateSegment(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === "\\" && i + 1 < segment.length) {
      out += escapeRegex(segment[++i]!);
    } else if (char === "*") {
      // A "**" that is not a whole segment is an ordinary "*" (git's rule).
      while (segment[i + 1] === "*") i++;
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = segment.slice(i + 1, close);
      let negated = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negated = true;
        body = body.slice(1);
      }
      out += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/g, (c) => `\\${c}`)}]`;
      i = close;
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

// Exported for the parity test against `git check-ignore`.
export function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith("#")) continue;
    // Trailing spaces are dropped unless the last one is escaped.
    while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.slice(0, -1);
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === "") continue;
    // A slash at the start or in the middle anchors the pattern to the
    // ignore file's own directory; otherwise it matches at any depth.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const segments = line.split("/");
    let source = "";
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") {
        source += last ? ".*" : "(?:.*/)?";
        return;
      }
      source += translateSegment(segment) + (last ? "" : "/");
    });
    const regex = new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`);
    const literal = !anchored && !/[*?[\\]/.test(line) ? line : undefined;
    rules.push(literal === undefined ? { regex, negate, dirOnly } : { regex, negate, dirOnly, literal });
  }
  return rules;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// The repository's common git directory for `projectRoot`, found by walking
// up to the nearest `.git`. A linked worktree's `.git` is a file that points
// at its own git directory, whose `commondir` names the shared one where
// info/exclude lives.
function findRepository(projectRoot: string): { root: string; commonDir: string } | undefined {
  let dir = projectRoot;
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      try {
        if (statSync(dotGit).isFile()) {
          const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
          if (match === null) return undefined;
          gitDir = resolve(dir, match[1]!.trim());
        }
      } catch {
        return undefined;
      }
      const commonDirText = readText(join(gitDir, "commondir"));
      const commonDir = commonDirText === undefined ? gitDir : resolve(gitDir, commonDirText.trim());
      return { root: dir, commonDir };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Every ignore file that applies above `projectRoot` itself: info/exclude
// and each .gitignore from the repository root down to the project root's
// parent. The project root's own .gitignore and every nested one are added
// by the caller as it reaches each directory (withGitignoreFile). Outside a
// repository this is empty, and the nested files still apply.
export function gitignoreStackAbove(projectRoot: string): GitignoreStack {
  const repository = findRepository(projectRoot);
  if (repository === undefined) return [];
  const layers: Layer[] = [];
  const add = (baseDir: string, text: string | undefined) => {
    if (text === undefined) return;
    const rules = parseGitignore(text);
    if (rules.length === 0) return;
    const fromBase = toPosix(relative(baseDir, projectRoot));
    layers.push(makeLayer(rules, fromBase === "" ? "" : `${fromBase}/`, 0));
  };
  add(repository.root, readText(join(repository.commonDir, "info", "exclude")));
  const between: string[] = [];
  for (let dir = projectRoot; dir !== repository.root; dir = dirname(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    between.unshift(parent);
  }
  for (const dir of between) add(dir, readText(join(dir, ".gitignore")));
  return layers;
}

// `stack` plus the .gitignore whose text is `text`, found in the directory
// at project-relative `dirRel` ("" for the project root).
export function withGitignoreFile(stack: GitignoreStack, dirRel: string, text: string): GitignoreStack {
  const rules = parseGitignore(text);
  if (rules.length === 0) return stack;
  return [...stack, makeLayer(rules, "", dirRel === "" ? 0 : dirRel.length + 1)];
}

// The deepest layer's last matching rule decides, the same precedence git
// uses. No match at all means not ignored.
export function isIgnoredBy(stack: GitignoreStack, rel: string, isDir: boolean): boolean {
  if (stack.length === 0) return false;
  const basename = rel.slice(rel.lastIndexOf("/") + 1);
  for (let l = stack.length - 1; l >= 0; l--) {
    const layer = stack[l]!;
    let best = layer.literalAny.get(basename) ?? -1;
    if (isDir) best = Math.max(best, layer.literalDir.get(basename) ?? -1);
    const local = layer.prefix + rel.slice(layer.strip);
    for (let p = layer.patterned.length - 1; p >= 0; p--) {
      const index = layer.patterned[p]!;
      if (index < best) break;
      const rule = layer.rules[index]!;
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(local)) {
        best = index;
        break;
      }
    }
    if (best >= 0) return !layer.rules[best]!.negate;
  }
  return false;
}

// The state of the entry at project-relative `rel`, given its parent's
// state. Git never re-includes a path under an ignored directory, so
// "ignored" is inherited; only a declared module's base directory (or
// single file) reverses it, for its whole subtree.
export function nextIgnoreState(
  parent: IgnoreState,
  stack: GitignoreStack,
  rel: string,
  isDir: boolean,
  forcedBases: ReadonlySet<string>,
): IgnoreState {
  if (parent === "forced") return "forced";
  const ignored = parent === "ignored" || isIgnoredBy(stack, rel, isDir);
  if (!ignored) return "kept";
  return forcedBases.has(rel) ? "forced" : "ignored";
}

// The walk's own decision for one path that the walk never visited: a file
// simulate proposes to create. Replays nextIgnoreState down the path's own
// directories, reading each directory's .gitignore on the way.
export function isPathGitignored(projectRoot: string, rel: string, forcedBases: ReadonlySet<string>): boolean {
  let stack = gitignoreStackAbove(projectRoot);
  const rootText = readText(join(projectRoot, ".gitignore"));
  if (rootText !== undefined) stack = withGitignoreFile(stack, "", rootText);
  const parts = rel.split("/");
  let state: IgnoreState = "kept";
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(0, i + 1).join("/");
    const isDir = i < parts.length - 1;
    state = nextIgnoreState(state, stack, sub, isDir, forcedBases);
    if (state === "kept" && isDir) {
      const text = readText(join(projectRoot, sub, ".gitignore"));
      if (text !== undefined) stack = withGitignoreFile(stack, sub, text);
    }
  }
  return state === "ignored";
}

// The project-relative base of every declared module whose glob names a
// real path (the literal part before the first wildcard). A base of ""
// (a glob like "**/*.ts") covers the whole project and forces nothing.
export function forcedBasesOf(bases: readonly string[]): { bases: Set<string>; ancestors: Set<string> } {
  const set = new Set<string>();
  const ancestors = new Set<string>();
  for (const base of bases) {
    if (base === "") continue;
    set.add(base);
    const parts = base.split("/");
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join("/"));
  }
  return { bases: set, ancestors };
}
