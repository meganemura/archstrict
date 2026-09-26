import { Secret } from "./secret.js";

// `export default <expr>` with no return annotation - the checker's own
// structural walk reads a function/class export's own signatures, so an
// anonymous default-exported function makes this independently visible,
// unlike a plain default-exported value (never walked at all - the
// checker's own algorithm only inspects call/construct signatures for a
// non-type-alias export).
export default function () {
  return { value: 1 } as Secret;
};
