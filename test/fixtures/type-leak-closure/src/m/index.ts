// Not a leak: Known is exported by name right here, and KnownHeritage
// below reaches it the same structural way HeritageWrapper reaches
// Secret - proof this fixture's own leaks come from Secret having no
// public name, not from the mechanism each one uses.
export { Known } from "./known.js";
export interface KnownHeritage extends Known {}

// Structural leak reached through a re-export chain with an alias
// (chain-a.js's own ChainWrapper, aliased to AliasedWrapper by
// chain-b.js), and through `export * from` (star.js re-exports
// chain-b.js's own AliasedWrapper without naming it again).
export { AliasedWrapper } from "./star.js";

// Structural leak reached through `export * as n from` (starns.js), then
// a namespace member access on the imported binding.
import { ChainNS2 } from "./starns.js";
export type ViaStarAs = ChainNS2.ChainWrapper;

// Structural leak reached through a namespace import.
import * as ChainNS from "./chain-a.js";
export type ViaNamespaceImport = ChainNS.ChainWrapper;

// Structural leak reached through a default import.
import DefaultWrapper from "./default-target.js";
export type ViaDefaultImport = DefaultWrapper;

// Structural leak reached through an `import("./x").Y` type.
export type ViaImportType = import("./import-type-target.js").ImportTypeWrapper;

// Structural leak reached through a namespace body's own `export type {}`
// specifier (a re-exported import binding inside a `declare namespace`).
import { NsBody } from "./nsbody.js";
export type ViaNsBody = { nested: NsBody.SecretForNsBody };

// A heritage clause and a generic constraint/default; `typeof` and a
// computed property name, each on an otherwise-unannotated declaration.
export { HeritageWrapper, GenericWrapper, TypeofWrapper, InferredConstWrapper, ComputedWrapper } from "./misc.js";

// Inferred-return and inferred-getter leaks - neither has a type
// annotation at all.
export { inferredFunction, GetterWrapper } from "./misc.js";

// Inferred leak through `export default <expr>` (an anonymous function,
// no return annotation) in a different file, re-exported here under a
// name.
export { default as ViaDefaultExpr } from "./default-expr.js";

// A plain value import with no type relevance at all - value-only.ts
// must stay out of rule 6's own closure Program (checked directly in
// this fixture's own test, not by a leak - there is nothing to leak
// here).
import { plainValue } from "./value-only.js";
export const total: number = plainValue + 1;
