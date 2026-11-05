import { token } from '@marmeon/core';

/**
 * The server is closing: what holds a response open — a live stream — ends, so `startServer().close()`, which waits for
 * every connection, is not held up by a tab that never goes away (its `EventSource` connects to the next server). One per
 * application; `drain()` and `close()` are the server's.
 *
 * Two steps: {@link draining} from the moment the server is told to stop — readiness answers 503 while it still takes
 * requests for the seconds in `SERVER_SHUTDOWN_DELAY_SECONDS` — and {@link signal} when it closes (streams end, liveness answers 503).
 */
export class ServerClosing {
  readonly #draining = new AbortController();
  readonly #closing = new AbortController();

  /** Aborted once the server closes. */
  get signal(): AbortSignal {
    return this.#closing.signal;
  }

  /** Aborted once the server is told to stop — before `SERVER_SHUTDOWN_DELAY_SECONDS`, and at the latest when it closes. */
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
 * What must be ready before the process takes requests: `startServer` (before its port accepts connections) and a test app run
 * the callbacks of {@link onServe}. A command never does. One per application; `begin()` is the server's.
 */
export class ServerServing {
  readonly #callbacks: ((deadlineMs: number) => Promise<void> | void)[] = [];

  /**
   * @internal — how long each callback may take (ms). A backend that accepts a connection and never answers must not keep the
   * port closed for good: the orchestrator would restart the process in a loop. Tests lower it.
   */
  deadlineMs = SERVING_DEADLINE_MS;

  /**
   * Runs `callback` before the process takes requests; it is told its deadline and handles its own failures (one that throws
   * stops the start). One still running at the deadline is left running and the start goes on.
   */
  onServe(callback: (deadlineMs: number) => Promise<void> | void): void {
    this.#callbacks.push(callback);
  }

  /** @internal — the server (and the test app), before the process takes requests. */
  async begin(slow?: (deadlineMs: number) => void): Promise<void> {
    for (const callback of this.#callbacks) {
      let timer: NodeJS.Timeout | undefined;
      try {
        // A little after the deadline the callback itself was told: one that keeps its own deadline has said so by then.
        const late = new Promise<'late'>((resolve) => (timer = setTimeout(resolve, this.deadlineMs + 100, 'late')));
        if ((await Promise.race([callback(this.deadlineMs), late])) === 'late') slow?.(this.deadlineMs);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** How long a callback of {@link ServerServing} may hold the start back (ms). */
const SERVING_DEADLINE_MS = 5_000;

/**
 * The request a container scope answers — bound per request by the kernel. For services that need a header of it outside the
 * pipeline (the live `Broadcaster` reads which tab sent it, `x-marmeon-connection`); controllers and middleware have `ctx`.
 */
export const IncomingRequest = token<Request>('IncomingRequest');
