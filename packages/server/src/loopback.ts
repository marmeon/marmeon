import { connect, createServer } from 'node:net';

/**
 * Whether another program holds `127.0.0.1:<port>` while this server is about to listen on every interface (`::`
 * or `0.0.0.0`) — the warning to log, or `undefined`. On every interface macOS lets a server listen beside a program that
 * holds the same port on 127.0.0.1 only: a request to 127.0.0.1 then reaches that program, one to `localhost` may reach
 * either. Elsewhere the start fails with EADDRINUSE right after. Asked before listening, by binding 127.0.0.1:<port> for a
 * moment: refused (EADDRINUSE) means someone holds it. Not asked for one chosen interface (a clash fails the start), nor for
 * `PORT=0` (the port is not known before listening) — nor in a cluster's worker (its primary asks once, before it forks).
 */
export async function heldOnLoopback(port: number, host: string): Promise<string | undefined> {
  if ((host !== '::' && host !== '0.0.0.0') || !(port > 0)) return undefined;
  const held = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE'));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(false)));
  });
  if (!held) return undefined;
  return (
    `Another program holds 127.0.0.1:${port} — this server listens on every interface (HOST ${host}), beside it on macOS: ` +
    `requests to 127.0.0.1:${port} reach that program, not this server. Unset HOST (127.0.0.1, this machine only) unless ` +
    'other machines must reach the app, or choose another PORT.'
  );
}

/**
 * Whether another program answers on `[::1]:<port>` while this server is about to listen on `127.0.0.1` alone — the warning to
 * log, or `undefined`. `localhost` may resolve to `::1`, and on macOS a program on `::` or `::1` does not stop a server on
 * 127.0.0.1 from taking the same port: `http://localhost:<port>` then reaches that program, silently. A bind on `::1` would not
 * see a holder on `::`, so this connects: a refusal, an unreachable `::1` (no IPv6 loopback) or a silent half second means nobody
 * is there. Not asked for another interface, nor for `PORT=0` (the port is not known before listening).
 */
export async function shadowedLocalhost(port: number, host: string): Promise<string | undefined> {
  if (host !== '127.0.0.1' || !(port > 0)) return undefined;
  const answered = await new Promise<boolean>((resolve) => {
    const probe = connect({ port, host: '::1' });
    probe.setTimeout(500);
    probe.once('connect', () => (probe.destroy(), resolve(true)));
    probe.once('timeout', () => (probe.destroy(), resolve(false)));
    probe.once('error', () => (probe.destroy(), resolve(false)));
  });
  if (!answered) return undefined;
  return (
    `Another program holds [::1]:${port} — http://localhost:${port} reaches it, not this server (it listens on 127.0.0.1). ` +
    `Open http://127.0.0.1:${port}, or stop that program or choose another PORT.`
  );
}
