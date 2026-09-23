// Responsibility: a thrown config or usage failure that carries the same
// `do` a violation already carries. The CLI prints both, text or JSON,
// so this path is not the one report that omits the command to run.
// Boundary: the message and the next command only. Formatting belongs to
// the CLI.
export class ReportError extends Error {
  readonly do: string;

  constructor(message: string, doText: string) {
    super(message);
    this.name = "ReportError";
    this.do = doText;
  }
}
