import { fromC } from "../c/module.ts";
export function fromB(): string {
  return "b" + fromC();
}
