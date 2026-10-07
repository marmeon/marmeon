import type { LiveHint } from '@marmeon/http';
import type { LiveHello } from './hub.ts';

/** One event of a live stream as a test reads it. */
export interface LiveEvent {
  readonly event: string;
  readonly id?: string | undefined;
  readonly data: unknown;
}

/**
 * A live stream read as it arrives (tests: `app.live(path)`) — its events (`hello`, `refresh`, `end`), the hints, the heartbeats
 * and `retry:`. `waitFor(…)` waits for what a test expects; `close()` hangs up like a tab that goes away.
 */
export class LiveStreamReader {
  readonly response: Response;
  readonly events: LiveEvent[] = [];
  /** How many heartbeats (comment lines) came. */
  heartbeats = 0;
  /** The `retry:` the server asked for (ms). */
  retry: number | undefined;
  /** Resolves when the stream ended (the server closed it, or `close()`). */
  readonly closed: Promise<void>;
  #ended = false;
  readonly #waiters = new Set<() => void>();
  readonly #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(response: Response) {
    this.response = response;
    this.#reader = response.ok && response.body ? response.body.getReader() : undefined;
    this.closed = this.#read();
  }

  get status(): number {
    return this.response.status;
  }

  /** Whether the stream ended. */
  get ended(): boolean {
    return this.#ended;
  }

  /** The hints (`refresh` events) so far. */
  get hints(): LiveHint[] {
    return this.events.filter((each) => each.event === 'refresh').map((each) => each.data as LiveHint);
  }

  /** The `hello` the stream opened with. */
  async hello(timeout = 2_000): Promise<LiveHello> {
    await this.waitFor(() => this.events.some((each) => each.event === 'hello'), timeout, 'hello');
    return this.events.find((each) => each.event === 'hello')!.data as LiveHello;
  }

  /** Waits until `count` hints came — or `until` holds — failing after `timeout` ms. */
  async waitFor(until: number | (() => boolean), timeout = 2_000, what = typeof until === 'number' ? `${until} hints` : 'the condition'): Promise<void> {
    const holds = typeof until === 'number' ? () => this.hints.length >= until : until;
    if (holds()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`The live stream did not get ${what} within ${timeout} ms — events: ${JSON.stringify(this.events)}`));
      }, timeout);
      const check = () => {
        if (!holds() && !this.#ended) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        if (holds()) resolve();
        else reject(new Error(`The live stream ended before ${what} — events: ${JSON.stringify(this.events)}`));
      };
      this.#waiters.add(check);
    });
  }

  /** Hangs up, like a tab that goes away. */
  async close(): Promise<void> {
    await this.#reader?.cancel().catch(() => undefined);
    await this.closed;
  }

  async #read(): Promise<void> {
    const reader = this.#reader;
    if (!reader) {
      this.#end();
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          this.#parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        this.#notify();
      }
    } catch {
      // Cancelled.
    }
    this.#end();
  }

  #parse(block: string): void {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) this.heartbeats++;
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
      else if (line.startsWith('retry: ')) this.retry = Number(line.slice(7));
    }
    if (data.length > 0) this.events.push({ event, id, data: JSON.parse(data.join('\n')) });
  }

  #end(): void {
    this.#ended = true;
    this.#notify();
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}
