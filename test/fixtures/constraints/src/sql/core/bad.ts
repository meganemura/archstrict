// Order violation: layer:core reaching layer:runtime, away from core.
import { sqlRuntimeThing } from "../runtime/thing.js";

export const bad = sqlRuntimeThing;
