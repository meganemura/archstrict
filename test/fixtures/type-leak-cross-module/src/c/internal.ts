// Module c's own internal file: Hidden is never re-exported from c's own
// surface (index.ts) - a consumer has no name for it from EITHER module.
export interface Hidden {
  y: number;
}
