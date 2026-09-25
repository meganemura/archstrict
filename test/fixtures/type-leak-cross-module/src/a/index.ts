// Module a's own public surface. f()'s return type, B, is declared in
// module b's own surface file - a consumer can already import it from
// there, so this is not a leak. g()'s return type, Hidden, is declared in
// module c's own internal file, never re-exported by c's surface - still
// a leak, and still owned by module a (the module doing the exposing),
// not by c.
import type { B } from "../b/index.js";
import type { Hidden } from "../c/internal.js";

export function f(): B {
  return { x: 1 };
}

export function g(): Hidden {
  return { y: 2 };
}
