// Responsibility: rule 4, the empty rule set (ArchUnitTS's Empty Test
// Protection). A configured rule that matches zero modules must not look
// like a pass — the same "0 が失敗に見える" principle as rule 3, from the
// other direction: rule 3 is "a module no kind covers is a failure"; this
// is "a kind (or a layer) that covers no module is a failure".
// Boundary: a config-vs-graph consistency check, not an edge check. No
// I/O, no output formatting.
import { kindPatternNames, invalidKindPatternMessage, type Config } from "../config.js";
import type { ModuleGraph } from "../module-graph.js";

export type Violation = {
  rule: "empty-rule-set";
  path: string; // config.configPath — this is a config-vs-graph check, not an edge check
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
};

const BECAUSE =
  "a rule that checks nothing must not look like a pass (ArchUnitTS's Empty Test Protection)";

function violation(config: Config, evidence: string, next: string): Violation {
  return {
    rule: "empty-rule-set",
    path: config.configPath,
    line: 1,
    column: 1,
    evidence,
    because: BECAUSE,
    next,
  };
}

export function checkEmptyRuleSet(graph: ModuleGraph, config: Config): Violation[] {
  const violations: Violation[] = [];

  // No modules at all: not "a rule matched zero", but "nothing to check" —
  // reported the same way (a violation, not a thrown error) so it fits the
  // same 0-is-a-result shape as everything else `check` reports.
  if (graph.modules.size === 0) {
    violations.push(
      violation(
        config,
        `no modules under '${config.modules}'`,
        `add at least one module directory under ${config.modules}, or check the modules glob in archstrict.config.ts`,
      ),
    );
  }

  for (const [kindName, pattern] of Object.entries(config.kinds)) {
    const matchedAny = [...graph.modules.keys()].some((moduleName) => {
      const result = kindPatternNames(pattern, config.modules, moduleName);
      if (result === "invalid") throw new Error(invalidKindPatternMessage(pattern, config.modules));
      return result;
    });
    if (!matchedAny) {
      violations.push(
        violation(
          config,
          `kind '${kindName}' (pattern '${pattern}') matches no discovered module`,
          `remove '${kindName}' from archstrict.config.ts, or point its pattern at a real module`,
        ),
      );
    }
  }

  for (const layerKind of config.layers ?? []) {
    if (!(layerKind in config.kinds)) {
      violations.push(
        violation(
          config,
          `layers names '${layerKind}', which is not a key of kinds`,
          `add '${layerKind}' to kinds in archstrict.config.ts, or remove it from layers`,
        ),
      );
    }
  }

  return violations;
}
