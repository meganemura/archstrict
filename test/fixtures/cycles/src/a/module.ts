import { fromB } from "../b/module.ts";
export function fromA(): string {
  return "a" + fromB();
}
