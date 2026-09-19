// Internal module: never exported by the fixture's public.ts.
export interface InternalRecord {
  secret: string;
}

export function buildRecord(secret: string): InternalRecord {
  return { secret };
}

export interface InternalConstraint {
  flag: boolean;
}

// A named alias over a mapped/utility type, the same shape nukadoko's real
// `StepFromMap` has (`Readonly<Record<string, FromCandidate | ...>>`): this
// is what exposed the aliasSymbol-vs-getSymbol() ordering bug in spike2.ts.
export type InternalAliasedRecord = Readonly<Record<string, InternalRecord>>;
