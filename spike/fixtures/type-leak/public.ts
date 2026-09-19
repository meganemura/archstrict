// Deliberately leaky public surface, for testing the leak detector against
// a known-positive case (nukadoko's real index.ts, checked elsewhere in
// spike2.ts, turned out to have none once type parameters and anonymous
// literals are excluded, so this proves the detector still fires on a real
// one).
import type { InternalRecord } from "./internal.js";
export { buildRecord } from "./internal.js"; // exports the function...
// ...but not InternalRecord itself: a consumer of buildRecord's return
// value receives a value typed InternalRecord with no import path to name
// it, and a caller writing an explicit annotation for it must reach past
// this file. That is the leak this fixture exists to produce.

export function wrapRecord(secret: string): { record: InternalRecord } {
  return { record: { secret } };
}
