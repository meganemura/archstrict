// Deliberately leaky public surface, for testing the leak detector against
// a known-positive case (nukadoko's real index.ts, checked elsewhere in
// spike2.ts, turned out to have none once type parameters and anonymous
// literals are excluded, so this proves the detector still fires on a real
// one).
import type {
  InternalAliasedRecord,
  InternalConstraint,
  InternalRecord,
} from "./internal.js";
export { buildRecord } from "./internal.js"; // exports the function...
// ...but not InternalRecord itself: a consumer of buildRecord's return
// value receives a value typed InternalRecord with no import path to name
// it, and a caller writing an explicit annotation for it must reach past
// this file. That is the leak this fixture exists to produce.

export function wrapRecord(secret: string): { record: InternalRecord } {
  return { record: { secret } };
}

// Alias-shadowed: `entries`' declared type is the named alias
// InternalAliasedRecord, but that alias's target is a mapped/utility type
// (`Readonly<Record<...>>`). The checker's `getSymbol()` on this property
// resolves to that mapped type's own anonymous symbol, not the alias a
// consumer actually sees on hover — only `aliasSymbol`, checked first,
// finds the name that is actually hidden.
export interface WithAliasedMap {
  entries: InternalAliasedRecord;
}

// Nested two levels down, through both a union member and an index
// signature's value type — requires real recursion past the exported
// type's own immediate properties, and requires reading index signatures
// as well as named properties.
export interface WithNestedLeak {
  wrapper: {
    tagged: string | InternalRecord;
    bag: Record<string, InternalRecord>;
  };
}

// An interface's own generic parameter, not a type alias's: candidate 2
// (generic parameter) must not be gated on the declaration being a type
// alias specifically.
export interface WithGenericConstraint<
  T extends InternalConstraint = InternalConstraint,
> {
  value: T;
}
