// Responsibility: attach structured config locations to raw violations and
// resolve each config value path against the config's TypeScript source.
// Boundary: rule evaluation and report formatting stay in their own modules.
// Rules can supply an exact index when duplicate config entries need distinct
// locations; this module owns the fallback selection for other findings.
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import type { Config } from "./config.js";

export type ConfigPointerRole = "fired" | "governs" | "edit-here";

export type ConfigPointer = {
  path: string;
  pointer: string;
  value: unknown;
  line: number;
  column: number;
  role: ConfigPointerRole;
};

export type ConfigPointers = ConfigPointer | readonly ConfigPointer[];

export type ConfigLocator = {
  pointer(path: string, role: ConfigPointerRole): ConfigPointer;
};

export type PointerSpec = { pointer: string; role: ConfigPointerRole };
export const CONFIG_POINTER_SPECS = Symbol("archstrict.config-pointer-specs");

export type UnlocatedViolation = {
  rule: string;
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
  todoModule?: string;
  [CONFIG_POINTER_SPECS]?: readonly PointerSpec[];
};

export type LocatedViolation<T extends UnlocatedViolation> = T & { config: ConfigPointers };

type PathPart = string | number;

function pathParts(pointer: string): PathPart[] {
  const parts: PathPart[] = [];
  const pattern = /(?:^|\.)([^.\[\]]+)|\[(\d+)\]/g;
  for (const match of pointer.matchAll(pattern)) {
    parts.push(match[2] === undefined ? match[1]! : Number(match[2]));
  }
  return parts;
}

function valueAt(config: Config, pointer: string): unknown {
  let value: unknown = config;
  for (const part of pathParts(pointer)) {
    if (typeof part === "number") {
      value = Array.isArray(value) ? value[part] : undefined;
    } else {
      value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
    }
  }
  if (Array.isArray(value) && value.length > 20) {
    return [...value.slice(0, 20), `... ${value.length - 20} more`];
  }
  return value ?? null;
}

export function withPointerSpecs<T extends object>(violation: T, specs: readonly PointerSpec[]): T {
  Object.defineProperty(violation, CONFIG_POINTER_SPECS, { value: specs });
  return violation;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isLiteralPosition(node: ts.Node): boolean {
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword;
}

function configObject(sourceFile: ts.SourceFile): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) return unwrap(statement.expression);
  }
  return undefined;
}

function syntaxAt(root: ts.Expression, parts: readonly PathPart[]): ts.Node {
  let current: ts.Node = root;
  let nearestLiteral: ts.Node = root;
  for (const part of parts) {
    const expression = ts.isExpression(current) ? unwrap(current) : current;
    let next: ts.Node | undefined;
    if (typeof part === "number" && ts.isArrayLiteralExpression(expression)) {
      // A spread contributes an unknown number of runtime entries. Once one
      // appears before this index, syntax indices no longer identify values.
      if (expression.elements.slice(0, part + 1).some(ts.isSpreadElement)) break;
      next = expression.elements[part];
    } else if (typeof part === "string" && ts.isObjectLiteralExpression(expression)) {
      let selected: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined;
      let selectedIndex = -1;
      let lastUnknownIndex = -1;
      expression.properties.forEach((candidate, index) => {
        if (ts.isSpreadAssignment(candidate)) {
          lastUnknownIndex = index;
          return;
        }
        if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) return;
        const name = propertyName(candidate.name);
        if (name === undefined) lastUnknownIndex = index;
        else if (name === part) {
          selected = candidate;
          selectedIndex = index;
        }
      });
      // A later spread or computed key can replace the selected runtime
      // value. The containing object is the nearest reliable literal then.
      if (selected === undefined || selectedIndex < lastUnknownIndex) break;
      next = ts.isPropertyAssignment(selected) ? selected.initializer : selected.name;
    }
    if (next === undefined) break;
    current = next;
    const unwrapped = ts.isExpression(next) ? unwrap(next) : next;
    if (isLiteralPosition(unwrapped)) nearestLiteral = unwrapped;
  }
  const selected = ts.isExpression(current) ? unwrap(current) : current;
  return isLiteralPosition(selected) ? selected : nearestLiteral;
}

export function createConfigLocator(config: Config, sourceOverride?: string): ConfigLocator {
  let sourceFile: ts.SourceFile | undefined;
  let root: ts.Expression | undefined;
  if (sourceOverride !== undefined || existsSync(config.configPath)) {
    const source = sourceOverride ?? readFileSync(config.configPath, "utf8");
    sourceFile = ts.createSourceFile(config.configPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    root = configObject(sourceFile);
  }

  return {
    pointer(pointer, role) {
      let line = 1;
      let column = 1;
      if (sourceFile !== undefined && root !== undefined) {
        const node = syntaxAt(root, pathParts(pointer));
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        line = position.line + 1;
        column = position.character + 1;
      }
      return { path: config.configPath, pointer, value: valueAt(config, pointer), line, column, role };
    },
  };
}

export function declaredModulePointerForName(config: Config, name: string | undefined): string {
  const index = config.declaredModules?.findIndex((entry) => entry.name === name) ?? -1;
  return index < 0 ? "declaredModules" : `declaredModules[${index}]`;
}

function edgeIdentifier(kind: "allowDeny" | "order" | "point", entry: Record<string, unknown>): string {
  if (kind === "allowDeny") return `${entry.source} -> ${entry.targetNamespace}`;
  if (kind === "order") return `${entry.tagNamespace}${entry.within === undefined ? "" : ` within ${entry.within}`}`;
  const from = typeof entry.from === "string" ? entry.from : JSON.stringify(entry.from);
  const to = typeof entry.to === "string" ? entry.to : JSON.stringify(entry.to);
  return `${from} -> ${to}`;
}

function indexByEvidence<T>(entries: readonly T[] | undefined, predicate: (entry: T) => boolean): number {
  return entries?.findIndex(predicate) ?? -1;
}

function pointerSpecs(violation: UnlocatedViolation, config: Config): PointerSpec[] {
  if (violation[CONFIG_POINTER_SPECS] !== undefined) return [...violation[CONFIG_POINTER_SPECS]];
  switch (violation.rule) {
    case "public-surface-bypass":
    case "type-leak":
      return [{ pointer: declaredModulePointerForName(config, violation.todoModule), role: "governs" }];
    case "uncovered-module":
      return [{ pointer: "declaredModules", role: "governs" }];
    case "cycle":
      return [
        { pointer: declaredModulePointerForName(config, violation.todoModule), role: "governs" },
        { pointer: "ignoredCycles", role: "edit-here" },
      ];
    case "stale-cycle-exception": {
      const index = indexByEvidence(config.ignoredCycles, ([a, b]) => violation.evidence.includes(`['${a}', '${b}']`));
      return [{ pointer: index < 0 ? "ignoredCycles" : `ignoredCycles[${index}]`, role: "fired" }];
    }
    case "must-be-empty": {
      const index = indexByEvidence(config.mustBeEmpty, (entry) => violation.evidence.includes(`'${entry.glob}'`));
      return [{ pointer: index < 0 ? "mustBeEmpty" : `mustBeEmpty[${index}]`, role: "fired" }];
    }
    case "deprecated-edge-increased": {
      const index = indexByEvidence(config.deprecated, (entry) => violation.evidence.startsWith(`${entry.from} -> ${entry.to}:`));
      return [{ pointer: index < 0 ? "deprecated" : `deprecated[${index}].count`, role: "fired" }];
    }
    case "tag-boundary": {
      const rules = config.edges?.allowDeny ?? [];
      const index = rules.findIndex((entry) => violation.because === entry.because && violation.evidence.includes(`from '${entry.source}'`));
      if (index < 0) return [{ pointer: "edges.allowDeny", role: "fired" }];
      const rule = rules[index]!;
      if (rule.deny !== undefined) {
        const deniedIndex = rule.deny.findIndex((value) => violation.evidence.includes(`'${rule.targetNamespace}:${value}'`));
        if (deniedIndex >= 0) return [
          { pointer: `edges.allowDeny[${index}].deny[${deniedIndex}]`, role: "fired" },
          { pointer: `edges.allowDeny[${index}].allow`, role: "edit-here" },
        ];
      }
      return [{ pointer: `edges.allowDeny[${index}].allow`, role: "fired" }];
    }
    case "tag-order": {
      const rules = config.edges?.order ?? [];
      const index = rules.findIndex((entry) => violation.because === entry.because && violation.evidence.includes(`(${entry.tagNamespace} sequence:`));
      return [{ pointer: index < 0 ? "edges.order" : `edges.order[${index}].sequence`, role: "fired" }];
    }
    case "point-rule": {
      const rules = config.edges?.point ?? [];
      const index = rules.findIndex((entry) => violation.because === entry.because &&
        violation.do.includes(`'${edgeIdentifier("point", entry as unknown as Record<string, unknown>)}'`));
      return [{ pointer: index < 0 ? "edges.point" : `edges.point[${index}]`, role: "fired" }];
    }
    case "clean-module-has-todo": {
      const index = config.strict?.findIndex((name) => violation.evidence.includes(`module '${name}'`)) ?? -1;
      return [{ pointer: index < 0 ? "strict" : `strict[${index}]`, role: "fired" }];
    }
    case "stale-todo":
      return [{ pointer: "declaredModules", role: "governs" }];
    case "empty-rule-set": {
      if (violation.evidence === "no modules declared in declaredModules") {
        return [{ pointer: "declaredModules", role: "fired" }];
      }
      const classifyIndex = indexByEvidence(config.classify, (entry) => violation.evidence.includes(`classify glob '${entry.glob}'`));
      if (classifyIndex >= 0) return [{ pointer: `classify[${classifyIndex}]`, role: "fired" }];
      const deprecatedIndex = indexByEvidence(config.deprecated, (entry) => violation.evidence.includes(`'${entry.from} -> ${entry.to}'`));
      if (deprecatedIndex >= 0) return [{ pointer: `deprecated[${deprecatedIndex}]`, role: "fired" }];
      for (const kind of ["allowDeny", "order", "point"] as const) {
        const rules = config.edges?.[kind] ?? [];
        const index = rules.findIndex((entry) => violation.evidence.includes(`${kind} rule '${edgeIdentifier(kind, entry as unknown as Record<string, unknown>)}'`));
        if (index >= 0) return [{ pointer: `edges.${kind}[${index}]`, role: "fired" }];
      }
      return [{ pointer: "edges", role: "fired" }];
    }
    case "exhaustive-allow-list": {
      const rules = config.edges?.allowDeny ?? [];
      const index = rules.findIndex((entry) => violation.because === entry.because &&
        violation.evidence.includes(`'${edgeIdentifier("allowDeny", entry as unknown as Record<string, unknown>)}'`));
      return [{ pointer: index < 0 ? "edges.allowDeny" : `edges.allowDeny[${index}].allow`, role: "fired" }];
    }
    case "config-meaning": {
      for (const kind of ["allowDeny", "order", "point"] as const) {
        const rules = config.edges?.[kind] ?? [];
        const index = rules.findIndex((entry) => violation.evidence.includes(`${kind} rule (`) && violation.because === entry.because);
        if (index >= 0) return [{ pointer: `edges.${kind}[${index}]`, role: "fired" }];
      }
      return [{ pointer: "edges", role: "governs" }];
    }
    default:
      return [{ pointer: "declaredModules", role: "governs" }];
  }
}

export function locateViolation<T extends UnlocatedViolation>(
  violation: T,
  config: Config,
  locator: ConfigLocator,
  specs: readonly PointerSpec[] = pointerSpecs(violation, config),
): LocatedViolation<T> {
  const pointers = specs.map(({ pointer, role }) => locator.pointer(pointer, role));
  const configPointers: ConfigPointers = pointers.length === 1 ? pointers[0]! : pointers;
  const primary = pointers[0]!;
  const position = violation.path === config.configPath ? { line: primary.line, column: primary.column } : {};
  return { ...violation, ...position, config: configPointers };
}

export function locateViolations<T extends UnlocatedViolation>(
  violations: readonly T[],
  config: Config,
  locator: ConfigLocator,
): LocatedViolation<T>[] {
  return violations.map((violation) => locateViolation(violation, config, locator));
}
