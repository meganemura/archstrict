// Responsibility: the constraint engine over `config.edges` - three
// shapes, generalizing over tags (src/classify.ts) instead of the fixed
// module/kind vocabulary rules 1-6 use. `allowDeny` (a source tag's
// allow/deny list over one target namespace at a time), `order` (a tag
// namespace's sequence, scoped within another namespace's equal value),
// and `point` (an explicit from/to edge, glob or tag-predicate on either
// side). One shared idea across all three: a rule scoped to a namespace
// says nothing about a target with no tag in that namespace - that's rule
// 3's ("uncovered") territory, not this rule's concern.
//
// Composition rule (the one sentence an implementer would otherwise get
// wrong): each `allowDeny`/`order` rule is evaluated independently, blind
// to every other rule's namespace. An edge violates if ANY ONE applicable
// rule says no - a plane-scoped rule and a domain-scoped rule can each
// clear the same edge or each independently condemn it; neither knows the
// other exists.
//
// `edgeType`/`importForm` filters on `point` are NOT applied here - that
// is a later ticket's job (Edge gaining `isDynamic`, and the filter logic
// itself); every edge matches every point rule's shape here regardless of
// type-only/value or static/dynamic.
//
// Boundary: pure predicates over a ModuleGraph and a Config, same as every
// other rule file. No I/O, no output formatting, no todo handling.
import { compileGlob } from "../classify.js";
import { classifyFile } from "../classify.js";
import { toProjectRelativePosix, type Edge, type ModuleGraph } from "../module-graph.js";
import type { Config } from "../config.js";

export type ConstraintViolation = {
  rule: "tag-boundary" | "tag-order" | "point-rule";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
  todoModule: string;
};

type AllowDenyRule = NonNullable<Config["edges"]>["allowDeny"] extends readonly (infer R)[] | undefined ? R : never;
type OrderRule = NonNullable<Config["edges"]>["order"] extends readonly (infer R)[] | undefined ? R : never;
type PointRule = NonNullable<Config["edges"]>["point"] extends readonly (infer R)[] | undefined ? R : never;
type FromToPredicate = string | { tags: readonly string[]; exclude?: { tags: readonly string[] } };

// A resolved edge's target tags: a synthesized `pkg:<name>` tag when the
// edge reaches outside this project entirely (a real npm package, a
// workspace dependency, a node builtin - module-graph.ts's own
// `externalPackage`), or the classified tags of the real file otherwise.
function tagsForTarget(edge: Edge, config: Config, rootDir: string): Set<string> {
  if (edge.externalPackage !== undefined) {
    return new Set([`pkg:${edge.externalPackage}`]);
  }
  return classifyFile(toProjectRelativePosix(edge.resolvedFile, rootDir), config);
}

// A glob can only match a real project-relative path - an external
// target's `resolvedFile` (node_modules, or a synthesized "node:x" for a
// builtin) has no such path, so a string `to`/`from` predicate simply
// never matches an external edge; only a tag predicate (matching the
// synthesized `pkg:` tag) can.
function targetRelPathForGlob(edge: Edge, rootDir: string): string | undefined {
  return edge.externalPackage !== undefined ? undefined : toProjectRelativePosix(edge.resolvedFile, rootDir);
}

function matchesPredicate(predicate: FromToPredicate, relPath: string | undefined, tags: Set<string>): boolean {
  if (typeof predicate === "string") {
    return relPath !== undefined && compileGlob(predicate).test(relPath);
  }
  if (!predicate.tags.every((t) => tags.has(t))) return false;
  if (predicate.exclude !== undefined && predicate.exclude.tags.every((t) => tags.has(t))) return false;
  return true;
}

function isExemptedByGlobPair(
  edge: Edge,
  exceptions: readonly { from: string; to: string; because: string }[] | undefined,
  rootDir: string,
): boolean {
  if (exceptions === undefined || exceptions.length === 0) return false;
  const fromRel = toProjectRelativePosix(edge.fromFile, rootDir);
  const toRel = targetRelPathForGlob(edge, rootDir);
  return exceptions.some(
    (ex) => compileGlob(ex.from).test(fromRel) && toRel !== undefined && compileGlob(ex.to).test(toRel),
  );
}

export function checkAllowDeny(graph: ModuleGraph, config: Config): ConstraintViolation[] {
  const rules: readonly AllowDenyRule[] = config.edges?.allowDeny ?? [];
  if (rules.length === 0) return [];
  const rootDir = graph.rootDir;
  const violations: ConstraintViolation[] = [];

  for (const edge of graph.edges) {
    const sourceTags = classifyFile(toProjectRelativePosix(edge.fromFile, rootDir), config);
    if (sourceTags.size === 0) continue;
    const targetTags = tagsForTarget(edge, config, rootDir);
    if (targetTags.size === 0) continue;

    for (const rule of rules) {
      if (!sourceTags.has(rule.source)) continue;
      if (targetTags.has(rule.source)) continue; // same group as source: unconstrained by this rule
      if (isExemptedByGlobPair(edge, rule.exceptions, rootDir)) continue;

      const namespacePrefix = `${rule.targetNamespace}:`;
      const targetValues = [...targetTags].filter((t) => t.startsWith(namespacePrefix));
      if (targetValues.length === 0) continue; // no tag in this namespace: not this rule's concern

      let violatingTag: string | undefined;
      if (rule.allow !== undefined) {
        const allowed = new Set(rule.allow.map((v) => `${namespacePrefix}${v}`));
        violatingTag = targetValues.find((v) => !allowed.has(v));
      } else if (rule.deny !== undefined) {
        const denied = new Set(rule.deny.map((v) => `${namespacePrefix}${v}`));
        violatingTag = targetValues.find((v) => denied.has(v));
      }
      if (violatingTag === undefined) continue;

      violations.push({
        rule: "tag-boundary",
        path: edge.fromFile,
        line: edge.fromPosition.line,
        column: edge.fromPosition.column,
        evidence: `'${edge.specifier}' (from '${rule.source}') reaches '${violatingTag}'`,
        because: rule.because,
        next: `remove this edge, or add '${violatingTag.slice(namespacePrefix.length)}' to '${rule.source}'s allow list in archstrict.config.ts and record why`,
        todoModule: edge.fromModule,
      });
    }
  }
  return violations;
}

// A tag value not present in its own rule's sequence is a config error
// (rule 4's territory - a rule that can't place a real value must not
// silently pass it), validated once up front rather than per edge.
function assertSequenceCoversValue(rule: OrderRule, withinValue: string | undefined, tag: string): void {
  const sequence = rule.sequence[withinValue ?? ""];
  if (sequence === undefined) {
    throw new Error(
      `order rule for '${rule.tagNamespace}' has no sequence entry for '${withinValue ?? "(unscoped)"}'`,
    );
  }
  const value = tag.slice(rule.tagNamespace.length + 1);
  if (!sequence.includes(value)) {
    throw new Error(
      `order rule for '${rule.tagNamespace}' (within '${withinValue ?? "(unscoped)"}') does not list '${value}' - every value classify assigns must appear in its sequence`,
    );
  }
}

export function checkOrder(graph: ModuleGraph, config: Config): ConstraintViolation[] {
  const rules: readonly OrderRule[] = config.edges?.order ?? [];
  if (rules.length === 0) return [];
  const rootDir = graph.rootDir;
  const violations: ConstraintViolation[] = [];

  for (const edge of graph.edges) {
    const sourceTags = classifyFile(toProjectRelativePosix(edge.fromFile, rootDir), config);
    const targetTags = tagsForTarget(edge, config, rootDir);

    for (const rule of rules) {
      const namespacePrefix = `${rule.tagNamespace}:`;
      const sourceLayer = [...sourceTags].find((t) => t.startsWith(namespacePrefix));
      const targetLayer = [...targetTags].find((t) => t.startsWith(namespacePrefix));
      if (sourceLayer === undefined || targetLayer === undefined) continue;

      let withinValue: string | undefined;
      if (rule.within !== undefined) {
        const withinPrefix = `${rule.within}:`;
        const sourceWithin = [...sourceTags].find((t) => t.startsWith(withinPrefix));
        const targetWithin = [...targetTags].find((t) => t.startsWith(withinPrefix));
        if (sourceWithin === undefined || targetWithin === undefined) continue;
        if (sourceWithin !== targetWithin) continue; // different scope entirely: this order rule doesn't cross it
        withinValue = sourceWithin.slice(withinPrefix.length);
      }

      assertSequenceCoversValue(rule, withinValue, sourceLayer);
      assertSequenceCoversValue(rule, withinValue, targetLayer);

      const sequence = rule.sequence[withinValue ?? ""]!;
      const sourceIndex = sequence.indexOf(sourceLayer.slice(namespacePrefix.length));
      const targetIndex = sequence.indexOf(targetLayer.slice(namespacePrefix.length));

      // "downward-only": a source may depend on its own layer or one
      // closer to the sequence's start (index 0 = innermost/core); reaching
      // a later index moves away from core, which is forbidden. Matches
      // dependency-cruiser's own generator: forbidden iff targetIndex >
      // sourceIndex.
      if (targetIndex <= sourceIndex) continue;

      violations.push({
        rule: "tag-order",
        path: edge.fromFile,
        line: edge.fromPosition.line,
        column: edge.fromPosition.column,
        evidence: `'${edge.specifier}' reaches '${targetLayer}' from '${sourceLayer}' (${rule.tagNamespace} sequence: ${sequence.join(" -> ")})`,
        because: rule.because,
        next: `move this edge to depend only on '${rule.tagNamespace}' values at or before '${sourceLayer.slice(namespacePrefix.length)}' in archstrict.config.ts's sequence, or restructure the code so it does`,
        todoModule: edge.fromModule,
      });
    }
  }
  return violations;
}

export function checkPoint(graph: ModuleGraph, config: Config): ConstraintViolation[] {
  const rules: readonly PointRule[] = config.edges?.point ?? [];
  if (rules.length === 0) return [];
  const rootDir = graph.rootDir;
  const violations: ConstraintViolation[] = [];

  for (const edge of graph.edges) {
    const sourceRel = toProjectRelativePosix(edge.fromFile, rootDir);
    const sourceTags = classifyFile(sourceRel, config);
    const targetTags = tagsForTarget(edge, config, rootDir);
    const targetRel = targetRelPathForGlob(edge, rootDir);

    for (const rule of rules) {
      if (!matchesPredicate(rule.from, sourceRel, sourceTags)) continue;
      if (!matchesPredicate(rule.to, targetRel, targetTags)) continue;

      violations.push({
        rule: "point-rule",
        path: edge.fromFile,
        line: edge.fromPosition.line,
        column: edge.fromPosition.column,
        evidence: `'${edge.specifier}' matches a forbidden edge`,
        because: rule.because,
        next: `remove this edge, or narrow the point rule in archstrict.config.ts if it's too broad`,
        todoModule: edge.fromModule,
      });
    }
  }
  return violations;
}

export function checkConstraints(graph: ModuleGraph, config: Config): ConstraintViolation[] {
  return [...checkAllowDeny(graph, config), ...checkOrder(graph, config), ...checkPoint(graph, config)];
}
