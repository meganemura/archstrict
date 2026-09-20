export type InternalRecord = { id: string };
export type SecretInternal = { secret: string };
export type Leaky = { record: SecretInternal };

export function buildSecretInternal(): SecretInternal {
  return { secret: "x" };
}
