import { widget } from "../a/public.ts";
import { secret } from "../a/internal.ts";
import { gadget } from "../b/module.ts";

export function useAll(): string {
  return widget() + secret() + gadget();
}
