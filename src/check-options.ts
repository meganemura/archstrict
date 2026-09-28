// Responsibility: parse the check verb's command-line options.
// Boundary: rule and module existence depend on the loaded project and are validated by check().
import { ReportError } from "./report-error.js";

export type CheckArgv = {
  asJson: boolean;
  prove: boolean;
  focusFile?: string;
  rules: string[];
  modules: string[];
};

export function parseCheckArgv(argv: readonly string[]): CheckArgv {
  const positional: string[] = [];
  const rules: string[] = [];
  const modules: string[] = [];
  let asJson = false;
  let prove = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--prove") {
      prove = true;
    } else if (arg === "--rule" || arg === "--module") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new ReportError(`${arg} requires a value`, "archstrict check [file] [--rule <id>] [--module <name>]");
      }
      (arg === "--rule" ? rules : modules).push(value);
    } else if (arg.startsWith("-")) {
      throw new ReportError(`unknown option '${arg}'`, "archstrict check [file] [--rule <id>] [--module <name>]");
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new ReportError("check takes at most one file", "archstrict check [file] [--rule <id>] [--module <name>]");
  }
  return { asJson, prove, focusFile: positional[0], rules, modules };
}
