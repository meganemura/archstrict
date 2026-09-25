// Module b's own public surface: B is exported by name right here, so a
// consumer already has a way to import it - from module b, not module a.
export interface B {
  x: number;
}
