import type { InternalRecord, SecretInternal } from "./internal.js";
import { buildSecretInternal } from "./internal.js";

// Not a leak: InternalRecord is exported by name right here, so a
// consumer has a name for it even though a property below also uses it.
export type { InternalRecord };
export type AlsoFine = { record: InternalRecord };

// Structural leak reached through a re-export, not a local declaration:
// Leaky's own declaration is an ExportSpecifier here, not a
// TypeAliasDeclaration, and Leaky's own shape (which references
// SecretInternal) still has to be walked.
export type { Leaky } from "./internal.js";

// Structural leak: this property's type is SecretInternal, never exported
// by name from this file.
export type WrapsInternal = { record: SecretInternal };

// Inferred-return leak: no explicit return type, and the return type
// itself IS the internal declaration (not merely nested in a property).
export function returnsInternalInferred() {
  return buildSecretInternal();
}

// Not a leak: the return type is annotated and is a plain, self-contained
// shape - nothing internal reachable from it.
export function returnsPlain(): { count: number } {
  return { count: 1 };
}

// Generic-parameter leak: the type parameter's constraint reaches an
// internal declaration.
export interface Holder<T extends SecretInternal> {
  value: T;
}
