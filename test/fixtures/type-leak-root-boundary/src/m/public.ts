import type { RootType } from "../../root-type.js";

// Structurally references RootType without exporting it by name - would
// be a leak if RootType counted as "internal", but it doesn't: it's
// outside every declared module's own boundary, not this project's own
// checked source in the sense rule 6 cares about.
export type Wraps = { record: RootType };
