/** The areas of the server's error codes (C and R are the browser's). See docs/errors.md#server-error-codes. */
export type ErrorCodeArea = 'K' | 'H' | 'D' | 'A' | 'Q' | 'S';

/** A stable error code: a letter for its area, a number never given twice — `D1`, `R2`. */
export type ErrorCode = `${ErrorCodeArea | 'C' | 'R'}${number}`;

const PREFIX = /^\[marmeon:([CRKHDAQS]\d+)\] /;

/** `[marmeon:K6] <message>` — the form of every coded error. */
export function withCode(code: ErrorCode, message: string): string {
  return `[marmeon:${code}] ${message}`;
}

/** The code a message starts with, if any — not looking at causes. */
export function codeOfMessage(message: string): ErrorCode | undefined {
  return (PREFIX.exec(message)?.[1] as ErrorCode | undefined);
}

/** `message` without its code prefix — for text that a coded error embeds in another one. */
export function withoutCode(message: string): string {
  return message.replace(PREFIX, '');
}

/** The code of `error`, else of the first cause that has one (five deep, like ErrorSolutions#find); `undefined` without. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = codeOfMessage(current.message);
    if (code) return code;
    current = current.cause;
  }
  return undefined;
}
