// Responsibility: which engine the edge walk uses (ARCHSTRICT_ENGINE), and
// ending the engine's process when a run is done.
// Boundary: no parsing and no resolution, and no import of typescript or
// tsrs: the CLI reads this before every verb, and loading a compiler here
// would cost `archstrict agents` and `--help` the time the CLI's lazy verb
// imports exist to save. The engines are in edge-engine.ts.
import { ReportError } from "./report-error.js";

export const EDGE_ENGINES = ["typescript", "tsrs"] as const;
export type EdgeEngineName = (typeof EDGE_ENGINES)[number];

// The one tsrs version this engine was checked against. tsrs follows a
// TypeScript 7 dev build under `unstable/` entry points, and a later
// release can change that API, so another installed version is refused
// rather than run on trust.
export const TSRS_VERSION = "0.14.1-ts7.1.0-dev.20260929";
export const TSRS_INSTALL = `npm install --save-dev --save-exact tsrs@${TSRS_VERSION}`;

// Read from the environment, not from archstrict.config.ts: the hooks and
// the MCP server already take their settings this way, and the engine is a
// property of the machine (tsrs has no binary for every platform), not of
// the project's architecture. Unset or empty selects the default. Any
// other value is refused: a typo that silently ran the default engine
// would report the default engine's answer under the other name.
export function parseEdgeEngine(value: string | undefined): EdgeEngineName {
  if (value === undefined || value === "" || value === "typescript") return "typescript";
  if (value === "tsrs") return "tsrs";
  throw new ReportError(
    `ARCHSTRICT_ENGINE is '${value}'; the accepted values are typescript (the default) and tsrs`,
    "unset ARCHSTRICT_ENGINE, or set it to typescript or tsrs",
  );
}

export function edgeEngineFromEnvironment(env: NodeJS.ProcessEnv = process.env): EdgeEngineName {
  return parseEdgeEngine(env.ARCHSTRICT_ENGINE);
}

const closers = new Set<() => void>();

// An engine that starts a process registers its own shutdown here, so the
// CLI can end it without importing the engine.
export function onEdgeEngineClose(close: () => void): void {
  closers.add(close);
}

// Ends the tsrs server process, if this process started one. The CLI calls
// it when a verb returns; a process that exits without it leaves the
// server to exit on its own about a second later (measured), not forever.
export function closeEdgeEngine(): void {
  for (const close of closers) close();
}
