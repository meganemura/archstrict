// Runs the built CLI as a process in a scratch project, the way an agent
// runs `npx archstrict`, and parses its --json output.
import { runCommand } from "nukadoko";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface CliJson {
  exitCode: number;
  json: unknown;
}

export async function runArchstrictJson(root: string, args: string[]): Promise<CliJson> {
  const result = await runCommand(process.execPath, [CLI_PATH, ...args, "--json"], { cwd: root });
  return { exitCode: result.exitCode ?? 1, json: JSON.parse(result.stdout) };
}

export interface CheckViolation {
  rule: string;
  path: string;
  line: number;
  do: string;
}

export async function runCheck(root: string): Promise<{ exitCode: number; violations: CheckViolation[] }> {
  const { exitCode, json } = await runArchstrictJson(root, ["check"]);
  const violations = (json as { violations: CheckViolation[] }).violations.map(({ rule, path, line, do: fix }) => ({ rule, path, line, do: fix }));
  return { exitCode, violations };
}
