// Thing is a real dependency's own type, not this project's own checked
// source - the consumer already has a name for it via `import { Thing }
// from "fakepkg"`, whichever declared module's glob happens to cover
// node_modules.
import type { Thing } from "fakepkg";

export function make(): Thing {
  return { value: "x" };
}
