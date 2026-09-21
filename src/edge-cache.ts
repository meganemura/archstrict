// Responsibility: store and validate complete snapshots of resolved source edges.
// Boundary: cache failures fall back to analysis; this module never resolves imports.
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Edge } from "./module-graph.js";

export type EdgeCache = {
  schema: 1;
  tsconfigHash: string;
  archstrictVersion: string;
  buildOptionsHash: string;
  metadata: Record<string, number | null>;
  files: Record<string, { mtimeMs: number; edges: Edge[] }>;
  // Program order can differ from directory order, including files with no edges.
  sourceOrder: string[];
  unsupportedSyntaxCount: number;
  unresolvedSpecifiers: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isEdge(value: unknown): value is Edge {
  if (!record(value) || !record(value.fromPosition)) return false;
  return ["fromFile", "fromModule", "specifier", "resolvedFile"].every((key) => typeof value[key] === "string") &&
    ["toModule", "externalPackage"].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    typeof value.isTypeOnly === "boolean" && typeof value.isDynamic === "boolean" &&
    [value.fromPosition.line, value.fromPosition.column].every((n) => Number.isInteger(n) && Number(n) > 0);
}
export function readEdgeCache(path: string): EdgeCache | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || value.schema !== 1 ||
        !["tsconfigHash", "archstrictVersion", "buildOptionsHash"].every((k) => typeof value[k] === "string") ||
        !record(value.metadata) || !Object.values(value.metadata).every((n) => n === null || typeof n === "number" && Number.isFinite(n)) ||
        !record(value.files) || !strings(value.sourceOrder) || !strings(value.unresolvedSpecifiers) ||
        !Number.isInteger(value.unsupportedSyntaxCount) || Number(value.unsupportedSyntaxCount) < 0) return undefined;
    for (const [file, entry] of Object.entries(value.files)) {
      if (!record(entry) || typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs) ||
          !Array.isArray(entry.edges) || !entry.edges.every((edge) => isEdge(edge) && edge.fromFile === file)) return undefined;
    }
    if (value.sourceOrder.length !== Object.keys(value.files).length ||
        new Set(value.sourceOrder).size !== value.sourceOrder.length ||
        value.sourceOrder.some((file) => !Object.hasOwn(value.files as object, file))) return undefined;
    return value as EdgeCache;
  } catch {
    return undefined;
  }
}
export function writeEdgeCache(path: string, cache: EdgeCache): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(cache), { flag: "wx" });
    renameSync(temporary, path);
  } catch {
    // A read-only cache directory must not prevent a fresh analysis result.
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup on read-only filesystems. */ }
  }
}
