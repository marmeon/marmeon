import { token } from '@bespokecore/core';

/**
 * The server is closing (W6.10): what holds a response open — a live stream — ends, so `startServer().close()`, which waits for
 * every connection, is not held up by a tab that never goes away (its `EventSource` connects to the next server). One per
 * application; `drain()` and `close()` are the server's.
 *
 * Two steps (E163): {@link draining} from the moment the server is told to stop — readiness answers 503 while it still takes
 * requests for `SHUTDOWN_DELAY` seconds — and {@link signal} when it closes (streams end, liveness answers 503).
 */
export class ServerClosing {
  readonly #draining = new AbortController();
  readonly #closing = new AbortController();

  /** Aborted once the server closes. */
  get signal(): AbortSignal {
    return this.#closing.signal;
  }

  /** Aborted once the server is told to stop — before `SHUTDOWN_DELAY` (E163), and at the latest when it closes. */
  get draining(): AbortSignal {
    return this.#draining.signal;
  }

  /** @internal — the server, when it is told to stop: not ready any more, still answering. */
  drain(): void {
    this.#draining.abort();
  }

  /** @internal — the server, when it closes. */
  close(): void {
    this.#draining.abort();
    this.#closing.abort();
  }
}

/**
 * The request a container scope answers — bound per request by the kernel. For services that need a header of it outside the
 * pipeline (the live `Broadcaster` reads which tab sent it, `x-bespoke-connection`); controllers and middleware have `ctx`.
 */
export const IncomingRequest = token<Request>('IncomingRequest');
