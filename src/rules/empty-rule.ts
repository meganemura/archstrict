// Responsibility: rule 4, the empty rule set (ArchUnitTS's Empty Test
// Protection). A configured rule that matches zero modules must not look
// like a pass — the same "0 が失敗に見える" principle as rule 3, from the
// other direction: rule 3 is "a module no kind covers is a failure"; this
// is "a kind (or a layer) that covers no module is a failure".
// Boundary: a config-vs-graph consistency check, not an edge check. No
// I/O, no output formatting.
import {
  assertDeprecatedModulesExist,
  assertKindPatternsSupported,
  kindPatternNames,
  type Config,
} from "../config.js";
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
  // Both validated up front, before the zero-modules early return below: a
  // config error must not depend on which branch runs first. Measured: the
  // zero-modules return used to sit above these checks, so a `deprecated`
  // entry naming a nonexistent module on an empty graph reached the
  // "actual count is 0" case (below) instead of throwing as a config
  // error — the same config was diagnosed two different ways depending on
  // which rule (this one, or rule 5) happened to run first.
  assertKindPatternsSupported(config);
  assertDeprecatedModulesExist(graph, config);

  const violations: Violation[] = [];

  // No modules at all: not "a rule matched zero", but "nothing to check" —
  // reported the same way (a violation, not a thrown error) so it fits the
  // same 0-is-a-result shape as everything else `check` reports. Returned
  // immediately rather than falling through to the per-kind loop below:
  // with zero modules, EVERY kind trivially matches nothing, so the loop
  // would add one redundant violation per configured kind, all restating
  // the same root cause this one violation already names. Measured: a
  // one-kind config produced 2 violations instead of 1 before this guard.
  if (graph.modules.size === 0) {
    return [
      violation(
        config,
        `no modules under '${config.modules}'`,
        `add at least one module directory under ${config.modules}, or check the modules glob in archstrict.config.ts`,
      ),
    ];
  }

  for (const [kindName, pattern] of Object.entries(config.kinds)) {
    const matchedAny = [...graph.modules.keys()].some(
      (moduleName) => kindPatternNames(pattern, config.modules, moduleName) === true,
    );
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

  // A deprecated edge whose actual count has fallen to zero is not merely
  // smaller (rule 5's "update count" suggestion) — the edge is gone
  // entirely, so the entry itself is moot and checks nothing. Rule 5
  // deliberately does not report this case (its own header explains why),
  // so it belongs here instead: an empty-rule-set violation, not a count
  // to shrink.
  for (const entry of config.deprecated ?? []) {
    const actual = graph.crossModuleEdges.filter(
      (e) => e.fromModule === entry.from && e.toModule === entry.to,
    ).length;
    if (actual === 0) {
      violations.push(
        violation(
          config,
          `deprecated edge '${entry.from} -> ${entry.to}' (declared count ${entry.count}) no longer exists`,
          `remove the '${entry.from} -> ${entry.to}' entry from deprecated in archstrict.config.ts`,
        ),
      );
    }
  }

  return violations;
}
