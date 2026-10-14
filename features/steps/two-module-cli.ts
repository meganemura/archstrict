// Runs the built CLI as a process in a scratch project, the way an agent
// runs `npx archstrict`, and parses its --json output.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface CliJson {
  exitCode: number;
  json: unknown;
}

export function runArchstrictJson(root: string, args: string[]): CliJson {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args, "--json"], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, json: JSON.parse(result.stdout) };
}

export interface CheckViolation {
  rule: string;
  path: string;
  line: number;
  do: string;
}

export function runCheck(root: string): { exitCode: number; violations: CheckViolation[] } {
  const { exitCode, json } = runArchstrictJson(root, ["check"]);
  const violations = (json as { violations: CheckViolation[] }).violations.map(({ rule, path, line, do: fix }) => ({ rule, path, line, do: fix }));
  return { exitCode, violations };
}
