import { token } from '@bespokecore/core';

/**
 * The server is closing (W6.10): what holds a response open — a live stream — ends, so `startServer().close()`, which waits for
 * every connection, is not held up by a tab that never goes away (its `EventSource` connects to the next server). One per
 * application; `close()` is the server's.
 */
export class ServerClosing {
  readonly #controller = new AbortController();

  /** Aborted once the server closes. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** @internal — the server, when it closes. */
  close(): void {
    this.#controller.abort();
  }
}

/**
 * The request a container scope answers — bound per request by the kernel. For services that need a header of it outside the
 * pipeline (the live `Broadcaster` reads which tab sent it, `x-bespoke-connection`); controllers and middleware have `ctx`.
 */
export const IncomingRequest = token<Request>('IncomingRequest');
