// Responsibility: convert between absolute file paths and the normalized,
// project-relative POSIX paths used by configuration and persistent caches,
// and the absolute path spelling used by TypeScript.
// Boundary: only compilerRealpath accesses the filesystem to resolve identity.
// Callers own path validation and all other filesystem access.
import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type ProjectRelativePath = (filePath: string) => string;

// TypeScript resolves Windows files with forward slashes. Native walk
// paths must use that spelling before they become graph identities.
export function toTypeScriptPath(path: string, separator: string = sep): string {
  return separator === "/" ? path : path.split(separator).join("/");
}

export function compilerJoin(...paths: string[]): string {
  return toTypeScriptPath(join(...paths));
}

export function compilerDirname(path: string): string {
  return toTypeScriptPath(dirname(path));
}

export function compilerRealpath(path: string): string {
  return toTypeScriptPath(realpathSync(path));
}

export function compilerResolve(...paths: string[]): string {
  return toTypeScriptPath(resolve(...paths));
}

// A graph asks for the same file through membership and rule checks. Keep
// one spelling so those checks do not repeat native path parsing.
export function makeProjectRelativePosix(projectRoot: string): ProjectRelativePath {
  const cache = new Map<string, string>();
  projectRoot = toTypeScriptPath(projectRoot);
  const rootPrefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  return (filePath: string): string => {
    filePath = toTypeScriptPath(filePath);
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;
    // The project walk produces descendants of one absolute root. Prefix
    // removal avoids parsing both absolute paths for that dominant case.
    const nativeResult = filePath === projectRoot ? ""
      : filePath.startsWith(rootPrefix) ? filePath.slice(rootPrefix.length)
      : relative(projectRoot, filePath);
    const result = toTypeScriptPath(nativeResult);
    cache.set(filePath, result);
    return result;
  };
}

// Cache paths are normalized project-relative POSIX paths. Parse the root
// once because a warm read restores every file and resolved target.
export function makeAbsolutePosix(projectRoot: string): (relativePath: string) => string {
  const windowsRoot = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(projectRoot);
  const normalizedRoot = windowsRoot ? projectRoot.replace(/\\/g, "/") : projectRoot;

  function splitAbsolute(path: string): { anchor: string; parts: string[] } {
    const drive = /^([A-Za-z]:)\/(.*)$/.exec(path);
    if (drive !== null) return { anchor: `${drive[1]}/`, parts: drive[2]!.split("/").filter(Boolean) };
    const unc = /^\/\/([^/]+)\/([^/]+)\/?(.*)$/.exec(path);
    if (unc !== null) return { anchor: `//${unc[1]}/${unc[2]}/`, parts: unc[3]!.split("/").filter(Boolean) };
    return { anchor: "/", parts: path.replace(/^\/+/, "").split("/").filter(Boolean) };
  }

  function appendNormalized(anchor: string, baseParts: readonly string[], path: string): string {
    const parts = [...baseParts];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return anchor + parts.join("/");
  }

  const root = splitAbsolute(normalizedRoot);
  return (relativePath: string): string => {
    const normalized = windowsRoot ? relativePath.replace(/\\/g, "/") : relativePath;
    if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
      const absolute = splitAbsolute(normalized);
      return appendNormalized(absolute.anchor, absolute.parts, "");
    }
    return appendNormalized(root.anchor, root.parts, normalized);
  };
}
