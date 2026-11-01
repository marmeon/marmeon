import type { Application } from './application.ts';

/**
 * Ends the process `afterMs` from now with `code` — for a command whose work may still hold the process open (a hung socket of a
 * job that ignored its signal). If the app is still shutting down by then, it waits for that first: the providers' time limit
 * must not be cut short by this timer, which starts before the shutdown does. Never keeps the process alive by itself.
 * @internal
 */
export function exitAfterShutdown(app: Application, code: number, afterMs: number, exit: (code: number) => void = process.exit): void {
  const attempt = () => {
    if (!app.shuttingDown) return exit(code);
    setTimeout(attempt, 100).unref();
  };
  setTimeout(attempt, afterMs).unref();
}
