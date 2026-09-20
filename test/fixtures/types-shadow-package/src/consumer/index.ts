import { fromNoTypesPkg } from "no-types-pkg";
import { readFileSync } from "node:fs";

export const x = fromNoTypesPkg;
export const y = typeof readFileSync;
