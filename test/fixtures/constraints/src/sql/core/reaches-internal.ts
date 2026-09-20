// Point-rule violation: src/** must not reach src/internal/**.
import { secret } from "../../internal/secret.js";

export const y = secret;
