// Responsibility: turn a config and the list of analyzed files into the diagram's model:
// modules, one layer stack, selectors with their per-module members, package sets, notes,
// and the links that the rules draw between them. All archstrict meaning lives here.
// Boundary: no Mermaid syntax and no file I/O. The files arrive as rows, so the model is a
// pure function and a test builds it without a disk.
//
// A rule joins selectors, never modules. Tags belong to files: in one real project a single
// module glob holds files of six layers, and a module-to-module arrow would claim a ban the
// config never wrote. Each selector therefore lists the modules that hold its files, with a
// file count when only some of a module's files match.
import { compileGlob } from "../config/classify.js";
import type { Config } from "../config/config.js";
import { DEFAULT_SURFACE, moduleGlobList } from "../graph/module-graph.js";
import { ReportError } from "../report-error.js";
import { formatPredicate, matchesPredicate, sequenceFor, type FromToPredicate } from "../rules/constraints.js";

export type FileRow = { readonly rel: string; readonly module: string | undefined; readonly tags: Set<string> };

export type Qualifier = {
  readonly edgeType: "value" | "type" | "both";
  readonly importForm: "static" | "dynamic" | "both";
};

export type LinkKind = "layer" | "allow" | "forbid" | "exempt" | "cycle" | "deprecated";

/** A module that holds `files` of its `of` analyzed files; `files < of` is a partial match. */
export type Membership = { readonly module: string; readonly files: number; readonly of: number };

export type ModuleNode = {
  readonly id: string;
  readonly name: string;
  readonly globs: readonly string[];
  /** null: the project default. [] is a module with no public surface file. */
  readonly surface: readonly string[] | null;
  readonly friends: readonly { readonly from: string; readonly file: string }[];
  /** Every tag any of the module's files carries, in code-unit order. */
  readonly tags: readonly string[];
  /** The stack value that every one of the module's files carries, or null. */
  readonly layer: string | null;
  /** Every stack-namespace value any file carries, in code-unit order. */
  readonly stackValues: readonly string[];
  /** Some file carries no stack-namespace value at all. */
  readonly stackGaps: boolean;
};

export type Stack = {
  readonly namespace: string;
  readonly rule: string;
  readonly qualifier: Qualifier;
  /** Highest layer first: the last value of the sequence is drawn on top. */
  readonly layers: readonly { readonly id: string; readonly value: string }[];
};

export type SelectorNode = {
  readonly id: string;
  readonly kind: "tag" | "glob" | "predicate" | "namespace";
  readonly text: string;
  readonly members: readonly Membership[];
};

export type PackageSet = { readonly id: string; readonly names: readonly string[] };

export type EmptyBox = { readonly id: string; readonly glob: string; readonly because: string };

export type Note = {
  readonly id: string;
  readonly kind: "project" | "stack" | "order";
  readonly lines: readonly string[];
  readonly qualifier: Qualifier;
  readonly because: string;
};

export type Link = {
  readonly kind: LinkKind;
  /** Node ids: m (module), l (layer), s (selector), k (package set). */
  readonly from: string;
  readonly to: string;
  /** Pointer into the config, such as `edges.point[3]`. */
  readonly rule: string;
  readonly qualifier: Qualifier;
  readonly because: string;
  /** The namespace of an allow list, or the count of a deprecated edge. */
  readonly subject: string | null;
  /** The rule's own package names when `to` is a package set shared with other rules. */
  readonly packages: readonly string[] | null;
};

export type DiagramModel = {
  readonly modules: readonly ModuleNode[];
  readonly stack: Stack | undefined;
  readonly selectors: readonly SelectorNode[];
  readonly packageSets: readonly PackageSet[];
  readonly mustBeEmpty: readonly EmptyBox[];
  readonly notes: readonly Note[];
  readonly links: readonly Link[];
};

const BOTH: Qualifier = { edgeType: "both", importForm: "both" };

/** `value`, `type`, `static`, `dynamic`, or a pair of them; null for the default qualifier. */
export function describeQualifier(qualifier: Qualifier): string | null {
  const parts = [
    ...(qualifier.edgeType === "both" ? [] : [qualifier.edgeType]),
    ...(qualifier.importForm === "both" ? [] : [qualifier.importForm]),
  ];
  return parts.length === 0 ? null : parts.join(", ");
}

// Code-unit order, never localeCompare: a locale-aware compare orders the same two names
// differently on different machines, and a committed diagram would then churn.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function qualifierOf(rule: { edgeType?: Qualifier["edgeType"]; importForm?: Qualifier["importForm"] }): Qualifier {
  return { edgeType: rule.edgeType ?? "both", importForm: rule.importForm ?? "both" };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function buildModules(config: Config, rows: readonly FileRow[], stackNamespace: string | undefined, layerValues: ReadonlySet<string>): ModuleNode[] {
  const projectSurface = config.surface === undefined ? DEFAULT_SURFACE : typeof config.surface === "string" ? [config.surface] : config.surface;
  const filesOf = new Map<string, FileRow[]>();
  for (const row of rows) {
    if (row.module === undefined) continue;
    filesOf.set(row.module, [...(filesOf.get(row.module) ?? []), row]);
  }
  return (config.declaredModules ?? []).map((declared, index) => {
    const files = filesOf.get(declared.name) ?? [];
    const own = declared.surface === undefined ? [] : typeof declared.surface === "string" ? [declared.surface] : declared.surface;
    const surface = declared.surface === undefined || sameSet(own, projectSurface) ? null : own;
    const tags = [...new Set(files.flatMap((file) => [...file.tags]))].sort(byCodeUnit);

    const prefix = `${stackNamespace}:`;
    const valuesPerFile = stackNamespace === undefined
      ? []
      : files.map((file) => [...file.tags].filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length)));
    const held = [...new Set(valuesPerFile.flat())].sort(byCodeUnit);
    const common = valuesPerFile.length === 0 ? [] : valuesPerFile[0]!.filter((value) => valuesPerFile.every((other) => other.includes(value)));
    const only = common.length === 1 ? common[0]! : undefined;
    return {
      id: `m${index}`,
      name: declared.name,
      globs: moduleGlobList(declared.glob),
      surface,
      friends: (declared.friends ?? []).map((friend) => ({ from: friend.from, file: friend.file })),
      tags,
      layer: only !== undefined && layerValues.has(only) ? only : null,
      stackValues: held,
      stackGaps: valuesPerFile.some((values) => values.length === 0),
    };
  });
}

type Pending = Omit<Link, "to" | "packages"> & {
  readonly target: { readonly id: string } | { readonly packages: readonly string[] };
  /** Keep this rule's packages out of the shared hexagon of its (kind, source, qualifier). */
  readonly alone?: boolean;
};

// Package targets of one (link kind, source, qualifier) share a hexagon, and hexagons with equal
// name lists are one node. Six point rules from one tag to six packages would otherwise draw six
// near-identical shapes. An allow list stays alone: every allow rule applies on its own, so a
// shared hexagon would read as the union of two lists that act as an intersection.
function resolveTargets(pending: readonly Pending[]): { links: Link[]; packageSets: PackageSet[] } {
  const groupKey = (p: Pending) => `${p.kind}\0${p.from}\0${p.qualifier.edgeType}\0${p.qualifier.importForm}\0${p.alone === true ? p.rule : ""}`;
  const namesOfGroup = new Map<string, string[]>();
  for (const p of pending) {
    if (!("packages" in p.target)) continue;
    const names = namesOfGroup.get(groupKey(p)) ?? [];
    for (const name of p.target.packages) if (!names.includes(name)) names.push(name);
    namesOfGroup.set(groupKey(p), names);
  }
  const packageSets: PackageSet[] = [];
  const idByNames = new Map<string, string>();
  const links = pending.map((p): Link => {
    const base = { kind: p.kind, from: p.from, rule: p.rule, qualifier: p.qualifier, because: p.because, subject: p.subject };
    if ("id" in p.target) return { ...base, to: p.target.id, packages: null };
    const names = namesOfGroup.get(groupKey(p))!;
    const nameKey = names.join("\0");
    let id = idByNames.get(nameKey);
    if (id === undefined) {
      id = `k${packageSets.length}`;
      idByNames.set(nameKey, id);
      packageSets.push({ id, names });
    }
    return { ...base, to: id, packages: [...p.target.packages] };
  });
  return { links, packageSets };
}

// formatPredicate prints JSON, which escapes into an unreadable label. A predicate needs every
// tag in `tags` and is lifted only when every tag in `exclude` is present, hence the joins.
function describePredicate(predicate: { tags: readonly string[]; exclude?: { tags: readonly string[] } }): string {
  const needs = predicate.tags.join(" + ");
  return predicate.exclude === undefined ? needs : `${needs} except ${predicate.exclude.tags.join(" + ")}`;
}

export function buildDiagramModel(config: Config, rows: readonly FileRow[]): DiagramModel {
  const orderRules = config.edges?.order ?? [];
  const stackRuleIndex = orderRules.findIndex((rule) => rule.within === undefined && sequenceFor(rule, undefined) !== undefined);
  const stackRule = stackRuleIndex === -1 ? undefined : orderRules[stackRuleIndex]!;
  const stackSequence = stackRule === undefined ? [] : [...sequenceFor(stackRule, undefined)!];
  const stack: Stack | undefined = stackRule === undefined
    ? undefined
    : {
      namespace: stackRule.tagNamespace,
      rule: `edges.order[${stackRuleIndex}]`,
      qualifier: qualifierOf(stackRule),
      layers: [...stackSequence].reverse().map((value, index) => ({ id: `l${index}`, value })),
    };
  const modules = buildModules(config, rows, stack?.namespace, new Set(stackSequence));

  const analyzedFiles = new Map<string, number>();
  for (const row of rows) if (row.module !== undefined) analyzedFiles.set(row.module, (analyzedFiles.get(row.module) ?? 0) + 1);
  const membersWhere = (matches: (row: FileRow) => boolean): Membership[] => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.module !== undefined && matches(row)) counts.set(row.module, (counts.get(row.module) ?? 0) + 1);
    return modules.flatMap((module) => {
      const files = counts.get(module.name);
      return files === undefined ? [] : [{ module: module.name, files, of: analyzedFiles.get(module.name) ?? files }];
    });
  };

  const selectors = new Map<string, SelectorNode>();
  // `identity` separates selectors whose displayed text is equal: a predicate prints as a short
  // join of its tags, and two different predicates can print alike.
  const selector = (kind: SelectorNode["kind"], text: string, matches: (row: FileRow) => boolean, identity: string = text): string => {
    const key = `${kind}\0${identity}`;
    const known = selectors.get(key);
    if (known !== undefined) return known.id;
    const id = `s${selectors.size}`;
    selectors.set(key, { id, kind, text, members: membersWhere(matches) });
    return id;
  };
  const layerIdOf = (tag: string): string | undefined =>
    stack === undefined || !tag.startsWith(`${stack.namespace}:`)
      ? undefined
      : stack.layers.find((layer) => layer.value === tag.slice(stack.namespace.length + 1))?.id;
  const tagSelector = (tag: string): string => layerIdOf(tag) ?? selector("tag", tag, (row) => row.tags.has(tag));
  // A glob names a module only when it is that module's one glob and matches exactly the module's
  // files: a nested module can own some of the files the glob matches, and a box would then claim
  // files the arrow does not cover.
  const moduleOfGlob = (glob: string): string | undefined => {
    const owners = modules.filter((module) => module.globs.length === 1 && module.globs[0] === glob);
    if (owners.length !== 1) return undefined;
    const owner = owners[0]!;
    const matched = rows.filter((row) => compileGlob(glob).test(row.rel));
    const own = rows.filter((row) => row.module === owner.name);
    return matched.length === own.length && matched.every((row) => row.module === owner.name) ? owner.id : undefined;
  };
  const globSelector = (glob: string): string =>
    moduleOfGlob(glob) ?? selector("glob", glob, (row) => compileGlob(glob).test(row.rel));
  const predicateSelector = (predicate: FromToPredicate): string => {
    if (typeof predicate === "string") return globSelector(predicate);
    if (predicate.exclude === undefined && predicate.tags.length === 1) return tagSelector(predicate.tags[0]!);
    return selector("predicate", describePredicate(predicate), (row) => matchesPredicate(predicate, row.rel, row.tags), formatPredicate(predicate));
  };
  const soleBarePackage = (predicate: FromToPredicate): string | undefined =>
    typeof predicate !== "string" && predicate.tags.length === 1 && predicate.tags[0]!.startsWith("pkg:")
      ? predicate.tags[0]!.slice("pkg:".length)
      : undefined;

  const pending: Pending[] = [];
  // An allowDeny rule exempts a target that carries the source tag, so its self-link says nothing.
  // A point rule and an exception have no such exemption: a self-link there is a real ban.
  const add = (link: Omit<Pending, "subject"> & { subject?: string | null }): void => {
    const exempt = /^edges\.allowDeny\[\d+\]$/.test(link.rule);
    if (exempt && "id" in link.target && link.target.id === link.from) return;
    pending.push({ subject: null, ...link });
  };

  if (stack !== undefined && stackRule !== undefined) {
    stack.layers.slice(0, -1).forEach((layer, index) =>
      add({ kind: "layer", from: layer.id, target: { id: stack.layers[index + 1]!.id }, rule: stack.rule, qualifier: stack.qualifier, because: stackRule.because }));
  }

  (config.edges?.allowDeny ?? []).forEach((rule, index) => {
    const from = tagSelector(rule.source);
    const values = rule.allow ?? rule.deny ?? [];
    const kind = rule.allow === undefined ? "forbid" : "allow";
    const common = { kind, from, rule: `edges.allowDeny[${index}]`, qualifier: qualifierOf(rule), because: rule.because, subject: kind === "allow" ? rule.targetNamespace : null } as const;
    // An allow list whose values are all the source's own tag forbids every other value, as an
    // empty one does. The own value draws nothing, so the rule would vanish without this.
    const targets = values.filter((value) => rule.targetNamespace === "pkg" || tagSelector(`${rule.targetNamespace}:${value}`) !== from);
    if (kind === "allow" && targets.length === 0) {
      const anyValue = rule.targetNamespace === "pkg"
        ? { packages: ["*"] }
        : { id: selector("namespace", `${rule.targetNamespace}:*`, (row) => [...row.tags].some((tag) => tag.startsWith(`${rule.targetNamespace}:`))) };
      add({ ...common, kind: "forbid", subject: null, target: anyValue, alone: true });
      return;
    }
    if (rule.targetNamespace === "pkg") {
      if (values.length > 0) add({ ...common, target: { packages: values }, alone: kind === "allow" });
      return;
    }
    for (const value of targets) add({ ...common, target: { id: tagSelector(`${rule.targetNamespace}:${value}`) } });
  });

  (config.edges?.point ?? []).forEach((rule, index) => {
    const from = predicateSelector(rule.from);
    const packageName = soleBarePackage(rule.to);
    add({
      kind: "forbid",
      from,
      target: packageName === undefined ? { id: predicateSelector(rule.to) } : { packages: [packageName] },
      rule: `edges.point[${index}]`,
      qualifier: qualifierOf(rule),
      because: rule.because,
    });
  });

  (config.edges?.allowDeny ?? []).forEach((rule, index) => {
    (rule.exceptions ?? []).forEach((exception, exceptionIndex) =>
      add({
        kind: "exempt",
        from: globSelector(exception.from),
        target: { id: globSelector(exception.to) },
        rule: `edges.allowDeny[${index}].exceptions[${exceptionIndex}]`,
        qualifier: BOTH,
        because: exception.because,
      }));
  });

  // A name that no module declares is check's to report; the diagram draws what it can resolve.
  const moduleId = (name: string): string | undefined => modules.find((module) => module.name === name)?.id;
  (config.ignoredCycles ?? []).forEach((pair, index) => {
    const [a, b] = [moduleId(pair[0]), moduleId(pair[1])];
    if (a !== undefined && b !== undefined) add({ kind: "cycle", from: a, target: { id: b }, rule: `ignoredCycles[${index}]`, qualifier: BOTH, because: "" });
  });
  (config.deprecated ?? []).forEach((entry, index) => {
    const [a, b] = [moduleId(entry.from), moduleId(entry.to)];
    if (a !== undefined && b !== undefined) {
      add({ kind: "deprecated", from: a, target: { id: b }, rule: `deprecated[${index}]`, qualifier: BOTH, because: entry.because, subject: String(entry.count) });
    }
  });

  const { links, packageSets } = resolveTargets(pending);

  const notes: Note[] = [];
  const addNote = (kind: Note["kind"], lines: string[], qualifier: Qualifier, because: string): void => {
    notes.push({ id: `n${notes.length}`, kind, lines, qualifier, because });
  };
  if (config.because !== "") addNote("project", [], BOTH, config.because);
  if (stack !== undefined && stackRule !== undefined) addNote("stack", [], stack.qualifier, stackRule.because);
  orderRules.forEach((rule, index) => {
    if (index === stackRuleIndex) return;
    // Without `within`, only the "" key is ever looked up, so any other key judges nothing.
    const keys = Object.keys(rule.sequence).filter((key) => rule.within !== undefined || key === "");
    const lines = rule.within === undefined && keys.length === 0
      ? [`order ${rule.tagNamespace}: never applies (no "" sequence and no within)`]
      : keys.map((key) => `order ${rule.tagNamespace}${key === "" ? "" : ` within ${rule.within}:${key}`}: ${rule.sequence[key]!.join(" < ")}`);
    addNote("order", lines, qualifierOf(rule), rule.because);
  });

  return {
    modules,
    stack,
    selectors: [...selectors.values()],
    packageSets,
    mustBeEmpty: (config.mustBeEmpty ?? []).map((entry, index) => ({ id: `e${index}`, glob: entry.glob, because: entry.because })),
    notes,
    links,
  };
}

/**
 * Keep one module, its selectors, and the links that touch them with their other ends. Ids stay
 * those of the full model, so a focused render is a subset of the full one.
 */
export function focusModel(model: DiagramModel, name: string): DiagramModel {
  const focus = model.modules.find((module) => module.name === name);
  if (focus === undefined) {
    throw new ReportError(
      `no declared module named '${name}'`,
      `archstrict diagram --focus <one of: ${model.modules.map((module) => module.name).join(", ")}>`,
    );
  }
  const stack = model.stack;
  const held = new Set<string>([focus.id]);
  for (const selector of model.selectors) if (selector.members.some((member) => member.module === name)) held.add(selector.id);
  for (const layer of stack?.layers ?? []) if (focus.stackValues.includes(layer.value)) held.add(layer.id);

  const touching = model.links.filter((link) => link.kind !== "layer" && (held.has(link.from) || held.has(link.to)));
  const kept = new Set<string>(held);
  for (const link of touching) {
    kept.add(link.from);
    kept.add(link.to);
  }
  const keepStack = stack !== undefined && stack.layers.some((layer) => kept.has(layer.id));
  const links = model.links.filter((link) => (link.kind === "layer" ? keepStack : touching.includes(link)));
  return {
    modules: model.modules.filter((module) => kept.has(module.id)),
    stack: keepStack ? stack : undefined,
    selectors: model.selectors.filter((selector) => kept.has(selector.id)),
    packageSets: model.packageSets.filter((set) => kept.has(set.id)),
    mustBeEmpty: [],
    notes: model.notes.filter((note) => note.kind === "stack" && keepStack),
    links,
  };
}
