// Responsibility: a thrown config or usage failure that carries the same
// `next` a violation already carries. The CLI prints both, text or JSON,
// so this path is not the one report that omits the command to run.
// Boundary: the message and the next command only. Formatting belongs to
// the CLI.
export class ReportError extends Error {
  readonly next: string;

  constructor(message: string, next: string) {
    super(message);
    this.name = "ReportError";
    this.next = next;
  }
}
