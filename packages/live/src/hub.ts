import { outsideTransaction, Redactor, type Logger } from '@marmeon/core';
import type { LiveHint } from '@marmeon/http';
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
  /**
   * Streams one session holds at most in this process (default 16) — beyond, 429: one user's tabs (or a script with their
   * cookie) cannot take every stream of the process (`maxStreams`) from everyone else.
   */
  readonly maxStreamsPerSession?: number | undefined;
}

/** The streams one session may hold in a process when nothing says otherwise (`LIVE_MAX_STREAMS_PER_SESSION`). */
export const MAX_STREAMS_PER_SESSION = 16;

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

/** One open stream: a tab's, for its channels. Exported for the hub's tests only (not from the package). */
export class OpenStream {
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
    // Closed while `hello` was prepared (the tab went away, the server closes): no heartbeat for a stream nobody reads.
    if (this.#closed) return;
    const channels = [...this.channels];
    channels.forEach((channel, index) => this.#seqs.set(channel, seqs[index] ?? 0));
    const seen = seenIn(lastEventId);
    const missed = channels.filter((channel) => seen.has(channel) && seen.get(channel) !== this.#seqs.get(channel));
    this.#write(`retry: ${retry}\n\n` + event('hello', { seq: Object.fromEntries(this.#seqs), ...(seen.size > 0 ? { missed } : {}) } satisfies LiveHello, eventId(this.#seqs)));
    const waiting = this.#waiting ?? [];
    this.#waiting = undefined;
    // Hints that came while `hello` was prepared: those it counted already are not told again (their sequence is at most its).
    for (const message of waiting) if (message.seq > (this.#seqs.get(message.channel) ?? 0)) this.hint(message);
    // A comment line now and then: proxies and load balancers close connections that stay silent (E104).
    this.#heartbeat = setInterval(() => outsideTransaction(() => this.#write(': heartbeat\n\n')), heartbeat * 1000);
    this.#heartbeat.unref?.();
  }

  /** A hint on one of its channels — never data. The connection that caused it gets it with nothing to reload. */
  hint(message: Extract<LiveMessage, { kind: 'refresh' }>): void {
    if (this.#closed || !this.channels.has(message.channel)) return;
    if (this.#waiting) return void this.#waiting.push(message);
    // After `hello` every hint is news: the backend delivers each refresh once, in the order of its sequence. One with a lower
    // sequence than the stream saw means the channel's counter started again (its key expired after a day without hints, was
    // evicted or flushed; the memory backend forgot it) — told, never dropped as "old" (W9 step 4).
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

/** A refusal as plain text (`EventSource` reads nothing of it): the status, why, and when to try again. */
const refuse = (status: number, message: string, retryAfter: string) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': retryAfter } });

/** Adds `stream` to the set under `key` — the index of a channel or a session. */
function index(map: Map<string, Set<OpenStream>>, key: string, stream: OpenStream): void {
  let streams = map.get(key);
  if (!streams) map.set(key, (streams = new Set()));
  streams.add(stream);
}

/** Takes `stream` out of the set under `key` — and the set, once it is empty. */
function unindex(map: Map<string, Set<OpenStream>>, key: string, stream: OpenStream): void {
  const streams = map.get(key);
  if (streams?.delete(stream) && streams.size === 0) map.delete(key);
}

/**
 * The live streams of this process (E89): it opens them, hands each the hints of its channels as the backend delivers them,
 * closes those of a session that ended (signed in or out — in any process) and all of them when the server closes. A
 * process holds at most `maxStreams`, a session at most `maxStreamsPerSession` of them (W9 step 4).
 *
 * A hint goes to the streams of its channel only (an index `channel → streams`), a session's end to the streams of that
 * session (`scope → streams`) — never a walk over every stream of the process. A stream takes its place in both indexes
 * before `open()` waits for anything, so the limits are counted atomically: fifty tabs opening at once never get past them.
 */
export class LiveHub {
  readonly #backend: LiveBackend;
  readonly #options: LiveHubOptions;
  readonly #perSession: number;
  readonly #logger: Logger;
  readonly #redactor: Redactor;
  readonly #streams = new Set<OpenStream>();
  readonly #channels = new Map<string, Set<OpenStream>>();
  readonly #sessions = new Map<string, Set<OpenStream>>();
  #listening: Promise<unknown> | undefined;
  #closed = false;

  /** `redactor` masks a failure's text in the log — the app's, so the names its packages add (the session cookie) count; without one, the core's key list. */
  constructor(backend: LiveBackend, options: LiveHubOptions, logger: Logger, closing?: AbortSignal, redactor: Redactor = new Redactor()) {
    this.#backend = backend;
    this.#options = options;
    this.#perSession = options.maxStreamsPerSession ?? MAX_STREAMS_PER_SESSION;
    this.#logger = logger;
    this.#redactor = redactor;
    // The server closes: no stream opens from now on (a request still on its way would hold `server.close()` until the hard
    // exit), and those open end — the browsers reconnect to the next server.
    const close = () => {
      this.#closed = true;
      this.closeStreams();
    };
    if (closing?.aborted) close();
    else closing?.addEventListener('abort', close, { once: true });
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
   *
   * Refused as plain text: 503 while the server closes or when the process holds `maxStreams`, 429 when the session holds
   * `maxStreamsPerSession` (the browser's `EventSource` gives up; the client tries again later).
   */
  async open(request: LiveStreamRequest): Promise<Response> {
    // Everything up to the first `await` runs at once: the checks and the stream's place in the indexes are one step.
    if (this.#closed) return refuse(503, 'The server is closing.', '1');
    if ((this.#sessions.get(request.scope)?.size ?? 0) >= this.#perSession) {
      this.#logger.warn('A session asked for more live streams than it may hold in this process (LIVE_MAX_STREAMS_PER_SESSION); refused with 429', {
        limit: this.#perSession,
      });
      return refuse(429, 'Too many live streams for this session.', '30');
    }
    if (this.#streams.size >= this.#options.maxStreams) return refuse(503, 'Too many live streams on this server.', '10');
    const stream = new OpenStream(request, () => this.#forget(stream));
    this.#streams.add(stream);
    index(this.#sessions, stream.scope, stream);
    for (const channel of stream.channels) index(this.#channels, channel, stream);
    try {
      await this.#listen();
      const seqs = await this.#backend.seqs([...stream.channels]);
      // The server began closing meanwhile: the stream is closed already (or would never be) — the browser asks the next one.
      if (this.#closed) {
        stream.close();
        return refuse(503, 'The server is closing.', '1');
      }
      stream.hello(seqs, request.lastEventId, this.#options);
    } catch (error) {
      stream.close();
      this.#logger.error('A live stream could not start (the live backend failed)', { exception: this.#redactor.text(String(error)) });
      return refuse(503, 'Live updates are unavailable.', '5');
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

  #forget(stream: OpenStream): void {
    this.#streams.delete(stream);
    unindex(this.#sessions, stream.scope, stream);
    for (const channel of stream.channels) unindex(this.#channels, channel, stream);
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
    const streams = message.kind === 'end' ? this.#sessions.get(message.scope) : this.#channels.get(message.channel);
    if (!streams) return;
    // A stream that ends (or breaks while written to) leaves the set meanwhile — a Set goes on with the next one.
    for (const stream of streams) {
      if (message.kind === 'end') stream.end();
      else stream.hint(message);
    }
  }
}
