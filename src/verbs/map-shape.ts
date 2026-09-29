// Responsibility: name two map shapes that look finished and hide which
// seams actually move. One module holding almost every file collapses
// hotspots and a frozen bypass list into one bucket. A file-per-module
// inventory checks imports between files and still names no growth seam.
// check, todo, recommend, and init share these thresholds so the note
// does not drift between verbs. It lives under verbs: the graph builder
// never calls it, so putting it in core would publish a verb-only helper
// on the analysis surface.
// Boundary: pure counts. No config I/O and no graph build.

// 4/5, the same share check.ts uses for "most bypasses share one cause".
// Integer math so a real fraction never rounds the wrong way.
export const DOMINANT_SHARE_NUMERATOR = 4;
export const DOMINANT_SHARE_DENOMINATOR = 5;
// Below this, a two-module sample project is not a mega-module, and a
// handful of bypasses is not a freeze to warn about.
export const DOMINANT_MIN_FILES = 8;
export const DOMINANT_MIN_BYPASSES = 8;
export const FILE_PER_MODULE_MIN = 4;

export function shareAtLeast(
  part: number,
  total: number,
  numerator = DOMINANT_SHARE_NUMERATOR,
  denominator = DOMINANT_SHARE_DENOMINATOR,
): boolean {
  return total > 0 && part * denominator >= total * numerator;
}

export type FileCount = { name: string; files: number };

export type DominantFiles = { name: string; files: number; totalFiles: number };

// The module with the most files, when it holds at least 4/5 of them and
// at least DOMINANT_MIN_FILES. A tie takes the name that sorts first, so
// the same counts always name the same module.
export function dominantByFiles(
  modules: readonly FileCount[],
  minFiles = DOMINANT_MIN_FILES,
): DominantFiles | undefined {
  const totalFiles = modules.reduce((sum, module) => sum + module.files, 0);
  let best: FileCount | undefined;
  for (const module of modules) {
    if (
      best === undefined
      || module.files > best.files
      || (module.files === best.files && module.name < best.name)
    ) {
      best = module;
    }
  }
  if (best === undefined || best.files < minFiles || !shareAtLeast(best.files, totalFiles)) return undefined;
  return { name: best.name, files: best.files, totalFiles };
}

export type DominantBypass = DominantFiles & { bypasses: number; totalBypasses: number };

// The file-dominant module, when it also owns at least 4/5 of the
// public-surface-bypass violations and at least DOMINANT_MIN_BYPASSES of
// them. Freezing that set records one bucket.
export function dominantBypassModule(
  modules: readonly FileCount[],
  bypassesByModule: ReadonlyMap<string, number>,
): DominantBypass | undefined {
  const files = dominantByFiles(modules);
  if (files === undefined) return undefined;
  let totalBypasses = 0;
  for (const count of bypassesByModule.values()) totalBypasses += count;
  const bypasses = bypassesByModule.get(files.name) ?? 0;
  if (bypasses < DOMINANT_MIN_BYPASSES || !shareAtLeast(bypasses, totalBypasses)) return undefined;
  return { ...files, bypasses, totalBypasses };
}

export function dominantBypassSentence(dominant: DominantBypass): string {
  return `${dominant.bypasses} of ${dominant.totalBypasses} public-surface-bypass violations target '${dominant.name}', which holds ${dominant.files} of ${dominant.totalFiles} analyzed files`;
}

export type FilePerModuleCluster = { parent: string; count: number; total: number };

// Single-file modules gathered in one directory, when they are at least
// 4/5 of the modules and at least FILE_PER_MODULE_MIN of them. Scattered
// single files across many directories are not this shape.
export function filePerModuleCluster(
  modules: readonly { files: number; parent: string }[],
): FilePerModuleCluster | undefined {
  const singles = modules.filter((module) => module.files === 1);
  if (singles.length < FILE_PER_MODULE_MIN || !shareAtLeast(singles.length, modules.length)) return undefined;
  const byParent = new Map<string, number>();
  for (const module of singles) byParent.set(module.parent, (byParent.get(module.parent) ?? 0) + 1);
  let bestParent = "";
  let bestCount = -1;
  for (const [parent, count] of byParent) {
    if (count > bestCount || (count === bestCount && parent < bestParent)) {
      bestParent = parent;
      bestCount = count;
    }
  }
  if (bestCount < FILE_PER_MODULE_MIN || !shareAtLeast(bestCount, modules.length)) return undefined;
  return { parent: bestParent, count: bestCount, total: modules.length };
}
