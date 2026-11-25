import type { Logger, LogContext } from '@marmeon/core';

/**
 * Writes one log entry and ignores a logger that throws, or whose method returns a promise that rejects. For every log on a request
 * path: a failing log sink must never skip an effect, never change how the request ends and never leave an unhandled rejection
 * behind. Effects are, for example, an ending, a suspension, a deleted token or the notice to an owner.
 */
export function logQuietly(logger: Logger | undefined, level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: LogContext): void {
  try {
    const written: unknown = logger?.[level](message, fields);
    if (typeof (written as { then?: unknown } | null | undefined)?.then === 'function') (written as PromiseLike<unknown>).then(undefined, () => {});
  } catch {
    // the entry is lost; the effect it reports stands
  }
}
