// Responsibility: provide named fixture types and factories for leak detection.
// Boundary: this file does not expose the module's public surface.
export interface Secret {
  secret: string;
}

export interface PublicSecret {
  value: string;
}

export class SecretBase {
  secret = "secret";
}

export class PublicBase {
  value = "public";
}

export function makeSecret(): Secret {
  return { secret: "secret" };
}

export function makePublicSecret(): PublicSecret {
  return { value: "public" };
}
