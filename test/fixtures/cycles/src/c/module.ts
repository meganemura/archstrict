import { fromA } from "../a/module.ts";
export function fromC(): string {
  return "c" + fromA();
}
