import { currentRequest, type Application, type RequestInfo } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';

/** What one request spent — its queries and server rendering (filled from the channels while it runs). */
interface Timing {
  db: number;
  queries: number;
  /** Set once the request rendered on the server. */
  ssr: number | undefined;
}

/**
 * The `Server-Timing` header (E129) — **development only** (`NODE_ENV=development`, never "not production"): `app` (the
 * request until its response), `db` (the queries' time, and how many) and `ssr` (server rendering until the shell). The
 * browser's network panel shows it per request.
 *
 * It listens to `db.query` and `render.ssr` for its app (`@marmeon/core/diagnostics`), from its provider's `boot` to
 * its `shutdown`. In production it does not exist: the channels keep no subscriber, the kernel sets no header.
 */
export class ServerTiming {
  /** Per request, keyed by its context object — a nested request (an island resolved in-process) has its own. */
  readonly #timings = new WeakMap<RequestInfo, Timing>();
  readonly #off: (() => void)[];

  constructor(app: Application) {
    const current = () => {
      const info = currentRequest();
      return info ? this.#timings.get(info) : undefined;
    };
    this.#off = [
      channels.subscribe(app, 'db.query', {
        end: (query) => {
          const timing = current();
          if (!timing) return;
          timing.db += query.durationMs;
          timing.queries++;
        },
      }),
      channels.subscribe(app, 'render.ssr', {
        end: (render) => {
          const timing = current();
          if (timing) timing.ssr = (timing.ssr ?? 0) + (render.durationMs ?? 0);
        },
      }),
    ];
  }

  /** Starts measuring the request whose context is `info`. */
  begin(info: RequestInfo): void {
    this.#timings.set(info, { db: 0, queries: 0, ssr: undefined });
  }

  /** The header's value for the request of `info`, which took `ms` until its response. */
  header(info: RequestInfo, ms: number): string | undefined {
    const timing = this.#timings.get(info);
    if (!timing) return undefined;
    const metrics = [`app;dur=${round(ms)};desc="App"`, `db;dur=${round(timing.db)};desc="${timing.queries} ${timing.queries === 1 ? 'query' : 'queries'}"`];
    if (timing.ssr !== undefined) metrics.push(`ssr;dur=${round(timing.ssr)};desc="SSR"`);
    return metrics.join(', ');
  }

  /** Stops listening (the provider's `shutdown`). */
  close(): void {
    for (const off of this.#off) off();
    this.#off.length = 0;
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
