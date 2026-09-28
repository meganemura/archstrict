// Responsibility: expose fixture values and derived types through the public surface.
// Boundary: this file does not declare the internal types under test.
import {
  makePublicSecret,
  makeSecret,
  PublicBase,
  PublicSecret,
  Secret,
  SecretBase,
} from "./internal.js";

export type { PublicBase, PublicSecret };

export const config = makeSecret();
export let mutableConfig = makeSecret();
export var legacyConfig = makeSecret();
export const factory = () => makeSecret();
export default makeSecret();
export const primitive = 1;
export const publicConfig = makePublicSecret();

export interface Wrapper extends Secret {}
export interface PublicWrapper extends PublicSecret {}

export class Derived extends SecretBase {}
export class PublicDerived extends PublicBase {}
