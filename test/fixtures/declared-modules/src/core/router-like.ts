// Mirrors NestJS's own router-explorer.ts: reaches directly into a sibling
// directory's internals, bypassing its own barrel index.ts, while staying
// inside the same declared module ("core"). Not a cross-module edge, so
// rule 1 (public-surface-bypass) has nothing to say about it - the barrel
// at src/core/injector/index.ts was never declared as its own module
// surface, so there is no boundary here to bypass.
import { container } from "./injector/container.js";

export const x = container;
