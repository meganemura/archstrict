// Responsibility: store the lazy module-augmentation scan for TypeScript
// files outside analysis. Each absolute file path owns one validated entry.
// Boundary: this module does not list, read, parse, or resolve project files.
// The caller supplies scan results and treats every cache failure as a miss.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type ts from "typescript";
import type { ModuleAugmentationSpecifier } from "./module-graph.js";

// An unknown shape is a silent miss. Trying to decode an older shape is
// refused because a stale negative answer can suppress a required fallback.
export const AUGMENTATION_CACHE_SCHEMA = 1;

export type CachedAugmentationEntry = {
  mtimeMs: number;
  size: number;
  optionsHash: string;
  impliedNodeFormat?: ts.ResolutionMode;
  specifiers: ModuleAugmentationSpecifier[];
};

export type AugmentationCache = {
  schema: typeof AUGMENTATION_CACHE_SCHEMA;
  archstrictVersion: string;
  files: Record<string, CachedAugmentationEntry>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is ts.ResolutionMode | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
}

function isSpecifier(value: unknown): value is ModuleAugmentationSpecifier {
  return record(value) && typeof value.specifier === "string" && isMode(value.mode);
}

function isEntry(value: unknown): value is CachedAugmentationEntry {
  return record(value) && typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) &&
    typeof value.size === "number" && Number.isFinite(value.size) &&
    typeof value.optionsHash === "string" && isMode(value.impliedNodeFormat) &&
    Array.isArray(value.specifiers) && value.specifiers.every(isSpecifier);
}

// Invalid content is a cache miss. Reporting cache damage is refused because
// the scan result remains available from the project files themselves.
export function readAugmentationCache(path: string, archstrictVersion: string): AugmentationCache | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!record(value) || value.schema !== AUGMENTATION_CACHE_SCHEMA ||
      value.archstrictVersion !== archstrictVersion || !record(value.files) ||
      !Object.values(value.files).every(isEntry)) return undefined;
  const entries = value.files as Record<string, CachedAugmentationEntry>;
  const files = Object.fromEntries(Object.entries(entries).map(([file, entry]) => [file, {
    ...entry,
    // JSON omits an undefined mode. Restoring the field is required because
    // callers use the same exact shape that the syntax scanner returns.
    specifiers: entry.specifiers.map((item) => ({ specifier: item.specifier, mode: item.mode })),
  }]));
  return { schema: AUGMENTATION_CACHE_SCHEMA, archstrictVersion, files };
}

// A temporary file keeps a killed writer from leaving partial JSON. Direct
// writes are refused because a later scoped check must treat the cache atomically.
export function writeAugmentationCache(
  path: string,
  archstrictVersion: string,
  files: Record<string, CachedAugmentationEntry>,
): void {
  const dir = dirname(path);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify({ schema: AUGMENTATION_CACHE_SCHEMA, archstrictVersion, files }));
    renameSync(temp, path);
  } finally {
    try { rmSync(temp); } catch { /* A successful rename already removes it. */ }
  }
}
