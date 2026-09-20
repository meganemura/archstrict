// Genuinely cross-module: "consumer" reaches into "core"'s undeclared
// internals directly, bypassing core's own declared surface
// (src/core/index.ts). This must still be a rule-1 violation - the
// declare-only model must not become permissive about cross-module
// bypasses just because the target happens to have a nested barrel too.
import { container } from "../core/injector/container.js";

export const y = container;
