import type { Logger, LogContext } from '@marmeon/core';

/**
 * Writes one log entry and ignores a logger that throws. For the places where a log stands next to an ending, a suspension, a deleted
 * token or the notice to an owner: a failing log sink must never skip one of them and never change how the request ends.
 */
export function logQuietly(logger: Logger | undefined, level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: LogContext): void {
  try {
    logger?.[level](message, fields);
  } catch {
    // the entry is lost; the effect it reports stands
  }
}
