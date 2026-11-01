import type { Application } from '@marmeon/core';

/** How long after the shutdown a command is cut off when a provider timed out. */
export const FORCED_EXIT_DELAY_MS = 2000;

/**
 * Shuts the app down. A provider whose `shutdown()` outlasted its limit may still hold a handle (a socket, a timer) that
 * keeps the process from ending on its own, so the exit is forced shortly after. The code is the command's own, or 1 when it
 * ended with 0: work was left behind, and cron, CI or a supervisor should notice.
 */
export async function shutDown(app: Application | undefined, exit: (code: number) => void = process.exit): Promise<void> {
  try {
    await app?.shutdown();
  } finally {
    if (app && app.stuckProviders.length > 0) setTimeout(() => exit(Number(process.exitCode) || 1), FORCED_EXIT_DELAY_MS).unref();
  }
}
