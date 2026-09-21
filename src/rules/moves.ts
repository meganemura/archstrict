// Responsibility: propose ranked moves for existing tag-boundary violations using the real graph and config.
// Boundary: decorates existing findings; never emits violations or applies edits.
// Retag moves are deferred: shared classification globs can affect sibling files and every rule that uses those tags.
// Such moves need a broader verification pass than these local proposals.
import { classifyFile, classifyByDirectoryName } from "../classify.js";
import type { Config } from "../config.js";
import { toProjectRelativePosix, type ModuleGraph } from "../module-graph.js";
import { computeAllowDeny, checkExhaustiveAllow, isExemptedByGlobPair, targetTagsInGraph,
  type AllowDenyMatch, type ConstraintViolation } from "./constraints.js";

export type Move = {
  kind: "reroute" | "exception" | "widen-allow" | "widen-deny";
  next: string;
  verified: boolean;
  widens?: true;
  creates?: string[];
};

export function computeMoves(violation: ConstraintViolation, graph: ModuleGraph, config: Config, context: AllowDenyMatch): Move[] | undefined {
  if (violation.rule !== "tag-boundary") return undefined;
  const { edge, ruleIndex, violatingTag } = context;
  const rules = config.edges?.allowDeny ?? [];
  const rule = rules[ruleIndex];
  if (!rule) return undefined;
  const prefix = `${rule.targetNamespace}:`;
  const legal = rule.allow !== undefined ? new Set(rule.allow.map(value => `${prefix}${value}`)) :
    new Set([...targetTagsInGraph(graph, config)].filter(tag => tag.startsWith(prefix) && tag !== rule.source &&
      !(rule.deny ?? []).includes(tag.slice(prefix.length))));
  const surfaces = new Set<string>();
  for (const module of graph.modules?.values() ?? []) {
    const tags = new Set(classifyByDirectoryName(toProjectRelativePosix(module.dir, graph.rootDir), config.classifyByDirectoryName));
    for (const surface of module.surfaceFiles) {
      for (const tag of classifyFile(toProjectRelativePosix(surface, graph.rootDir), config)) tags.add(tag);
    }
    if ([...tags].some(tag => legal.has(tag))) {
      for (const surface of module.surfaceFiles) surfaces.add(toProjectRelativePosix(surface, graph.rootDir));
    }
  }
  const moves: Move[] = [];
  if (surfaces.size > 0) moves.push({ kind: "reroute", verified: false,
    next: `consider importing from these public surfaces: ${JSON.stringify([...surfaces].sort())}; confirm the needed symbol is available` });

  const from = toProjectRelativePosix(edge.fromFile, graph.rootDir);
  const to = edge.externalPackage === undefined ? toProjectRelativePosix(edge.resolvedFile, graph.rootDir) : undefined;
  if (to !== undefined && !from.includes("*") && !to.includes("*")) {
    const entry = { from, to, because: "<author must state a real reason>" };
    moves.push({ kind: "exception", widens: true,
      verified: isExemptedByGlobPair(edge, [...rule.exceptions ?? [], entry], graph.rootDir),
      next: `add ${JSON.stringify(entry)} to exceptions for allowDeny entry ${ruleIndex}; this exempts only this one edge pair` });
  }

  const value = violatingTag.slice(prefix.length);
  const modified = rule.allow !== undefined ? { ...rule, allow: [...rule.allow, value] } :
    { ...rule, deny: (rule.deny ?? []).filter(item => item !== value) };
  const hypothetical: Config = { ...config, edges: { ...config.edges,
    allowDeny: rules.map((entry, index) => index === ruleIndex ? modified : entry) } };
  const before = computeAllowDeny(graph, config).matches;
  const after = computeAllowDeny(graph, hypothetical).matches;
  const sameEdgeRule = (a: AllowDenyMatch, b: AllowDenyMatch) => a.edge === b.edge && a.ruleIndex === b.ruleIndex;
  const creates = new Set(after.filter(match => !before.some(old => sameEdgeRule(old, match))).map(match => match.violation.rule as string));
  const beforeExhaustive = checkExhaustiveAllow(graph, config);
  for (const finding of checkExhaustiveAllow(graph, hypothetical)) {
    const index = hypothetical.edges!.allowDeny!.indexOf(finding.rule);
    if (!beforeExhaustive.some(old => rules.indexOf(old.rule) === index && old.ruleId === finding.ruleId)) creates.add(finding.ruleId);
  }
  const move: Move = {
    kind: rule.allow !== undefined ? "widen-allow" : "widen-deny", widens: true,
    verified: !after.some(match => match.edge === edge && match.ruleIndex === ruleIndex),
    next: rule.allow !== undefined ? `add ${JSON.stringify(value)} to allow for allowDeny entry ${ruleIndex}` :
      `remove ${JSON.stringify(value)} from deny for allowDeny entry ${ruleIndex}`,
  };
  if (creates.size > 0) move.creates = [...creates].sort();
  moves.push(move);
  return moves;
}
