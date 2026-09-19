// Responsibility: rule 3, uncovered modules (deptrac's --fail-on-uncovered).
// A module that matches no kind in the config fails the check — the
// implementation of the project's own rule "0 が失敗に見える" (a check that
// silently skipped a module must not look like that module passed).
// Boundary: pure predicate over a ModuleGraph and a Config. No I/O, no
// output formatting.
import type { Config } from "../config.ts";
import type { ModuleGraph } from "../module-graph.ts";

export type Violation = {
  rule: "uncovered-module";
  path: string; // the module's directory
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
};

const BECAUSE =
  "a module matching no kind is unchecked, not passing (deptrac's --fail-on-uncovered)";

// Whether `pattern` (a value of config.kinds) names `moduleName`. Returns
// "invalid" for a pattern shape v0 does not support (see config.ts's
// header) — the caller must not treat that the same as "does not match".
function matches(pattern: string, modulesGlob: string, moduleName: string): boolean | "invalid" {
  if (pattern === modulesGlob) return true;
  const root = modulesGlob.slice(0, -1); // "src/*" -> "src/"
  if (!pattern.startsWith(root)) return "invalid";
  const rest = pattern.slice(root.length);
  if (rest.includes("*")) return "invalid"; // a nested wildcard: out of scope for v0's single-level modules
  return rest === moduleName;
}

export function checkUncoveredModules(graph: ModuleGraph, config: Config): Violation[] {
  const violations: Violation[] = [];

  for (const [name, module] of graph.modules) {
    const matchingKinds = Object.entries(config.kinds).filter(([, pattern]) => {
      const result = matches(pattern, config.modules, name);
      if (result === "invalid") {
        throw new Error(
          `kind pattern '${pattern}' is not a shape v0 supports (modules glob is '${config.modules}'): ` +
            `use the modules glob itself, or '<modules-root>/<exact-module-name>'`,
        );
      }
      return result;
    });

    if (matchingKinds.length > 1) {
      throw new Error(
        `module '${name}' matches more than one kind (${matchingKinds.map(([k]) => k).join(", ")}); ` +
          `kinds must not overlap`,
      );
    }

    if (matchingKinds.length === 0) {
      violations.push({
        rule: "uncovered-module",
        path: module.dir,
        line: 1,
        column: 1,
        evidence: `module '${name}' matches no kind in ${JSON.stringify(config.kinds)}`,
        because: BECAUSE,
        next: `add '${name}' to an existing kind's pattern, or give it its own kind in archstrict.config.ts`,
      });
    }
  }

  return violations;
}
