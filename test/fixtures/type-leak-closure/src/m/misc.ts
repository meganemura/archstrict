import { Secret } from "./secret.js";

// heritage clause: exercised syntactically (secret.ts must join the
// closure through this reference too), even though this particular
// shape (no member of its own) gives the checker nothing new to flag -
// value's own type is number, not Secret.
export interface HeritageWrapper extends Secret {}

// generic constraint and default
export interface GenericWrapper<T extends Secret = Secret> { value: T }

// typeof, on an unannotated const (`as Secret` is a type assertion on the
// initializer, not a declaration annotation - this const still has none):
// wrapped in a property so the checker's own structural walk (which never
// inspects a plain exported value's own type directly) has something to
// walk into.
export const typeofSource = { value: 1 } as Secret;
export type TypeofWrapper = { nested: typeof typeofSource };

// unannotated const, independently: wrapped the same way, so this leak
// is attributable to the const's own inference and not to typeofSource
// above.
export const inferredConst = { value: 1 } as Secret;
export type InferredConstWrapper = { nested: typeof inferredConst };

// computed property name (a class member whose own name is computed, not
// a plain identifier) - a property, not a method: the checker's own
// structural walk reads a class's own properties, not a method's return
// type.
const secretKey = "secretProp";
export class ComputedWrapper {
  [secretKey]: Secret = { value: 1 };
}

// unannotated function: the return type is inferred, not annotated
export function inferredFunction() {
  return { value: 1 } as Secret;
}

// unannotated getter: same inference rule, a different declaration shape
export class GetterWrapper {
  get secret() {
    return { value: 1 } as Secret;
  }
}
