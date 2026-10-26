/**
 * The arguments do not fit the command: the message says what, and how the command is used. Thrown by a command's `handle()`,
 * `marmeon` prints the message and exits with 2 — a wrong call, not a failure. The `marmeon` package exports it too. See docs/console.md#exit-codes.
 */
export class CommandArgumentsError extends Error {
  override name = 'CommandArgumentsError';
}
