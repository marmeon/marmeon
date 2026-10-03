import { outsideTransaction, type Logger } from '@bespokecore/core';
import type { LiveHint } from '@bespokecore/http';
import type { LiveBackend, LiveMessage } from './backend.ts';

/** What `hello` says when a stream opens: the current sequence of each channel — and, after a reconnect, those it missed. */
export interface LiveHello {
  readonly seq: Readonly<Record<string, number>>;
  /** Channels whose sequence moved since the `Last-Event-ID` the browser sent (a reconnect of the same `EventSource`). */
  readonly missed?: readonly string[];
}

/** One stream to open: who listens (the session's scope, the tab's connection) to what. */
export interface LiveStreamRequest {
  readonly channels: readonly string[];
  readonly scope: string;
  readonly connection: string;
  /** The `Last-Event-ID` of a reconnect — the sequences the stream had seen. */
  readonly lastEventId?: string | null | undefined;
  /** The client went away. */
  readonly signal?: AbortSignal | undefined;
}

export interface LiveHubOptions {
  /** Seconds between heartbeats. */
  readonly heartbeat: number;
  /** Milliseconds a browser waits before reconnecting (`retry:`). */
  readonly retry: number;
  /** Streams this process holds at most. */
  readonly maxStreams: number;
}

/** The headers of a live stream (E104): an event stream, never cached, transformed or buffered on its way (nginx: X-Accel-Buffering). */
export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store, no-transform',
  'x-accel-buffering': 'no',
};

const encoder = new TextEncoder();

/** An event of the stream: `event:`, `id:`, `data:` (one line — JSON) and the blank line that ends it. */
const event = (name: string, data: unknown, id?: string) => `event: ${name}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;

/** The sequences a stream saw, as its event id: `users.7=4&dashboard.sign-ins=12` — what the browser sends back as `Last-Event-ID`. */
const eventId = (seqs: ReadonlyMap<string, number>) => new URLSearchParams([...seqs].map(([channel, seq]) => [channel, String(seq)])).toString();

/** The sequences of a `Last-Event-ID` — only well-formed ones. */
function seenIn(lastEventId: string | null | undefined): Map<string, number> {
  const seen = new Map<string, number>();
  if (!lastEventId || lastEventId.length > 8192) return seen;
  for (const [channel, seq] of new URLSearchParams(lastEventId)) if (/^\d{1,15}$/.test(seq)) seen.set(channel, Number(seq));
  return seen;
}

/** One open stream: a tab's, for its channels. */
class OpenStream {
  readonly scope: string;
  readonly connection: string;
  readonly channels: ReadonlySet<string>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly #seqs = new Map<string, number>();
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  /** Hints that came before `hello` went out — sent after it, those newer than what it said. */
  #waiting: Extract<LiveMessage, { kind: 'refresh' }>[] | undefined = [];
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  readonly #stop: () => void;

  constructor(request: LiveStreamRequest, onClose: () => void) {
    this.scope = request.scope;
    this.connection = request.connection;
    this.channels = new Set(request.channels);
    this.#stop = onClose;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      // The client went away (the tab closed, the stream was replaced).
      cancel: () => this.close(),
    });
    if (request.signal?.aborted) queueMicrotask(() => this.close());
    request.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Opens with `retry:` and `hello` (the channels' sequences), then the hints that came meanwhile; heartbeats from now on. */
  hello(seqs: readonly number[], lastEventId: string | null | undefined, { retry, heartbeat }: Pick<LiveHubOptions, 'retry' | 'heartbeat'>): void {
    const channels = [...this.channels];
    channels.forEach((channel, index) => this.#seqs.set(channel, seqs[index] ?? 0));
    const seen = seenIn(lastEventId);
    const missed = channels.filter((channel) => seen.has(channel) && seen.get(channel) !== this.#seqs.get(channel));
    this.#write(`retry: ${retry}\n\n` + event('hello', { seq: Object.fromEntries(this.#seqs), ...(seen.size > 0 ? { missed } : {}) } satisfies LiveHello, eventId(this.#seqs)));
    const waiting = this.#waiting ?? [];
    this.#waiting = undefined;
    for (const message of waiting) this.hint(message);
    // A comment line now and then: proxies and load balancers close connections that stay silent (E104).
    this.#heartbeat = setInterval(() => outsideTransaction(() => this.#write(': heartbeat\n\n')), heartbeat * 1000);
    this.#heartbeat.unref?.();
  }

  /** A hint on one of its channels — never data. The connection that caused it gets it with nothing to reload. */
  hint(message: Extract<LiveMessage, { kind: 'refresh' }>): void {
    if (this.#closed || !this.channels.has(message.channel)) return;
    if (this.#waiting) return void this.#waiting.push(message);
    // Already told (the hint came before `hello` counted it): not again.
    if (message.seq <= (this.#seqs.get(message.channel) ?? 0)) return;
    this.#seqs.set(message.channel, message.seq);
    const hint: LiveHint = { channel: message.channel, only: message.except === this.connection ? [] : message.only, seq: message.seq };
    this.#write(event('refresh', hint, eventId(this.#seqs)));
  }

  /** The session ended: the browser is told not to reconnect, and the stream closes. */
  end(): void {
    if (this.#closed) return;
    this.#write(event('end', {}));
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#waiting = undefined;
    try {
      this.#controller.close();
    } catch {
      // Cancelled by the client already.
    }
    this.#stop();
  }

  #write(text: string): void {
    if (this.#closed) return;
    try {
      this.#controller.enqueue(encoder.encode(text));
    } catch {
      this.close();
    }
  }
}

/**
 * The live streams of this process (E89): it opens them, hands each the hints of its channels as the backend delivers them,
 * closes those of a session that ended (signed in or out — in any process) and all of them when the server closes. A
 * process holds at most `maxStreams`.
 */
export class LiveHub {
  readonly #backend: LiveBackend;
  readonly #options: LiveHubOptions;
  readonly #logger: Logger;
  readonly #streams = new Set<OpenStream>();
  #listening: Promise<unknown> | undefined;
  #closed = false;

  constructor(backend: LiveBackend, options: LiveHubOptions, logger: Logger, closing?: AbortSignal) {
    this.#backend = backend;
    this.#options = options;
    this.#logger = logger;
    closing?.addEventListener('abort', () => this.closeStreams(), { once: true });
  }

  /** How many streams this process holds open. */
  get size(): number {
    return this.#streams.size;
  }

  /** This process holds as many streams as it may (`LIVE_MAX_STREAMS`). */
  get full(): boolean {
    return this.#streams.size >= this.#options.maxStreams;
  }

  /** The streams of this process, for tests: their scope, connection and channels. */
  streams(): readonly { readonly scope: string; readonly connection: string; readonly channels: readonly string[] }[] {
    return [...this.#streams].map(({ scope, connection, channels }) => ({ scope, connection, channels: [...channels] }));
  }

  /**
   * Opens a stream: the response to send (an event stream). It hears hints from now on — those that come while `hello` is
   * being prepared go out right after it — and `hello` says where each channel stands.
   */
  async open(request: LiveStreamRequest): Promise<Response> {
    if (this.#closed) return new Response('The server is closing.', { status: 503, headers: { 'retry-after': '1' } });
    await this.#listen();
    const stream = new OpenStream(request, () => this.#streams.delete(stream));
    this.#streams.add(stream);
    try {
      const seqs = await this.#backend.seqs([...stream.channels]);
      stream.hello(seqs, request.lastEventId, this.#options);
    } catch (error) {
      stream.close();
      this.#logger.error('A live stream could not start (the live backend failed)', { exception: String(error) });
      return new Response('Live updates are unavailable.', { status: 503, headers: { 'retry-after': '5' } });
    }
    return new Response(stream.readable, { status: 200, headers: STREAM_HEADERS });
  }

  /** Closes every stream (the server closes: the browsers reconnect to the next one). */
  closeStreams(): void {
    for (const stream of [...this.#streams]) stream.close();
  }

  /** Closes every stream and stops listening (the app shuts down). */
  async close(): Promise<void> {
    this.#closed = true;
    this.closeStreams();
    await this.#backend.close();
  }

  #listen(): Promise<unknown> {
    this.#listening ??= this.#backend
      .listen((message) => outsideTransaction(() => this.#deliver(message)))
      .catch((error: unknown) => {
        this.#listening = undefined;
        throw error;
      });
    return this.#listening;
  }

  #deliver(message: LiveMessage): void {
    for (const stream of [...this.#streams]) {
      if (message.kind === 'end') {
        if (stream.scope === message.scope) stream.end();
      } else {
        stream.hint(message);
      }
    }
  }
}
