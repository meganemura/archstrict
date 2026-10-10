// Responsibility: say when a path argument names a file the analysis did not read.
// Boundary: no rule evaluation. A missing path stays the caller's error.
// The note stays off the result object. check --json is what the PostToolUse
// hook reads, and that hook speaks when the JSON has an error or a violation.
// A field on the result would change that JSON. The formatter holds the same
// object the verb returned, so a WeakMap can carry the sentence without a
// field JSON.stringify would keep.
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { compileGlob } from "../classify.js";
import type { Config } from "../config.js";
import { DEFAULT_SURFACE, isEligibleSourceFile, toProjectRelativePosix } from "../module-graph.js";
import { compilerDirname, compilerJoin, compilerRealpath, compilerResolve } from "../project-path.js";

export type FocusSkip = "outside" | "excluded" | "unanalyzed";

// Precedence is fixed so two facts about one path cannot produce two notes.
// Outside wins, because an exclude glob is not what kept the file out.
// A directory is a scope, and the config file is still read as config, so
// neither is "not analyzed" even when an exclude glob matches it.
export function classifyFocus(facts: {
  outside: boolean;
  directory: boolean;
  configFile: boolean;
  excluded: boolean;
  eligible: boolean;
}): FocusSkip | undefined {
  if (facts.outside) return "outside";
  if (facts.directory || facts.configFile) return undefined;
  if (facts.excluded) return "excluded";
  if (!facts.eligible) return "unanalyzed";
  return undefined;
}

export function focusSkipNote(file: string, reason: FocusSkip): string {
  if (reason === "outside") return `${file} is outside the project, so it was not analyzed`;
  if (reason === "excluded") return `${file} is excluded, so it was not analyzed`;
  return `${file} was not analyzed`;
}

const focusNotes = new WeakMap<object, readonly string[]>();

export function setFocusNotes(result: object, notes: readonly string[]): void {
  if (notes.length > 0) focusNotes.set(result, notes);
}

export function focusNoteLines(result: object): readonly string[] {
  return focusNotes.get(result) ?? [];
}

// A proposed path may not exist yet. Resolve the nearest existing ancestor,
// then append the missing segments, so a symlink in the project root still
// lands on the same path the graph uses.
function canonicalPath(projectRoot: string, file: string): string {
  const absolute = compilerResolve(projectRoot, file);
  if (existsSync(absolute)) return compilerRealpath(absolute);
  const missing = [basename(absolute)];
  let ancestor = compilerDirname(absolute);
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = compilerDirname(ancestor);
    if (parent === ancestor) return absolute;
    ancestor = parent;
  }
  return compilerJoin(compilerRealpath(ancestor), ...missing);
}

function sameFile(canonical: string, configPath: string | undefined): boolean {
  if (configPath === undefined) return false;
  const resolved = compilerResolve(configPath);
  if (!existsSync(resolved)) return resolved === canonical;
  return compilerRealpath(resolved) === canonical;
}

export function focusSkip(projectRoot: string, file: string, config: Config): FocusSkip | undefined {
  const root = compilerRealpath(compilerResolve(projectRoot));
  const canonical = canonicalPath(root, file);
  const rel = toProjectRelativePosix(canonical, root);
  const outside = rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  const directory = existsSync(canonical) && statSync(canonical).isDirectory();
  const excluded = (config.exclude ?? []).some((glob) => compileGlob(glob).test(rel));
  // An outside path is not a project file. Skip the eligibility walk so a
  // `../` segment is not read as a directory inside this project.
  const eligible = outside ? false : isEligibleSourceFile(
    canonical,
    root,
    config.exclude ?? [],
    config.declaredModules ?? [],
    config.surface ?? DEFAULT_SURFACE,
  );
  return classifyFocus({
    outside,
    directory,
    configFile: sameFile(canonical, config.configPath),
    excluded,
    eligible,
  });
}
