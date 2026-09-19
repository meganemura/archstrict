// Internal module: never exported by the fixture's public.ts.
export interface InternalRecord {
  secret: string;
}

export function buildRecord(secret: string): InternalRecord {
  return { secret };
}
