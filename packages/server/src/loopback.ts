import { createServer } from 'node:net';

/**
 * Whether another program holds `127.0.0.1:<port>` while this server is about to listen on every interface (no `HOST`, `::` or
 * `0.0.0.0`) — the warning to log, or `undefined`. On every interface macOS lets a server listen beside a program that holds the same port
 * on 127.0.0.1 only: a request to 127.0.0.1 then reaches that program, one to `localhost` may reach either (W9 step 2: a 501 from
 * `/up`, 1Password on 127.0.0.1:39127). Elsewhere the start fails with EADDRINUSE right after. Asked before listening, by binding
 * 127.0.0.1:<port> for a moment: refused (EADDRINUSE) means someone holds it. Not asked for one chosen interface (a clash fails
 * the start), nor for `PORT=0` (the port is not known before listening) — nor in a cluster's worker (its primary
 * asks once, before it forks: a worker's bind would go through the primary).
 */
export async function heldOnLoopback(port: number, host: string | undefined): Promise<string | undefined> {
  if ((host !== undefined && host !== '::' && host !== '0.0.0.0') || !(port > 0)) return undefined;
  const held = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE'));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(false)));
  });
  if (!held) return undefined;
  return (
    `Another program holds 127.0.0.1:${port} — this server listens on every interface (HOST ${host ?? 'not set'}), beside it on macOS: ` +
    `requests to 127.0.0.1:${port} reach that program, not this server. Set HOST (127.0.0.1 behind a proxy on this machine, ` +
    '0.0.0.0 in a container) or another PORT.'
  );
}
