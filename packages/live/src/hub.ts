import { outsideTransaction, type Logger, type Redactor } from '@marmeon/core';
import type { LiveHint } from '@marmeon/http';
import type { LiveBackend, LiveMessage } from './backend.ts';
import { monotonicNow } from './monotonic.ts';
import { ACCOUNT_PREFIX } from './signer.ts';

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
  /** The scopes of the account behind the stream, one per key of `APP_KEY` the process knows, when a sign-in stands behind it. */
  readonly accounts?: readonly string[] | undefined;
  /** When the sign-in was asked about (ms, on the hub's monotonic clock, not epoch time): an end of the account that arrived after is not known to the answer. */
  readonly checkedAt?: number | undefined;
  readonly connection: string;
  /** The `Last-Event-ID` of a reconnect — the sequences the stream had seen. */
  readonly lastEventId?: string | null | undefined;
  /** The client went away. */
  readonly signal?: AbortSignal | undefined;
}

export interface LiveHubOptions {
  /** Seconds between heartbeats. */
  readonly heartbeatSeconds: number;
  /** Milliseconds a browser waits before reconnecting (`retry:`). */
  readonly retryMs: number;
  /** Streams this process holds at most. */
  readonly maxStreams: number;
  /**
   * Streams one session holds at most in this process (default 16) — beyond, 429: one user's tabs (or a script with their
   * cookie) cannot take every stream of the process (`maxStreams`) from everyone else.
   */
  readonly maxStreamsPerSession?: number | undefined;
  /**
   * Seconds a stream lives at most (default 900, `LIVE_MAX_STREAM_SECONDS`), with up to a quarter less by chance: then it closes and
   * its browser connects again and is checked. Bounds every ending nobody announced (a sign-in's maximum lifetime, an idle session,
   * a message that was missed).
   */
  readonly maxStreamSeconds?: number | undefined;
}

/** The streams one session may hold in a process when nothing says otherwise (`LIVE_MAX_STREAMS_PER_SESSION`). */
export const MAX_STREAMS_PER_SESSION = 16;

/** Ends of one kind the hub remembers at most (a flood of messages cannot grow it without bound). */
const MAX_REMEMBERED_ENDS = 100_000;

/** How long an end is remembered (ms): longer than any request should take between reading its session and opening its stream. */
const REMEMBER_ENDS_MS = 60_000;

/**
 * The scopes that ended lately, newest last (the map stays in time order: pruning only looks at the oldest). Anything dropped
 * moves `#forgotten` up, so a stream whose moment lies before it knows an end of its own may be gone with the dropped ones.
 */
class RecentEnds {
  readonly #ends = new Map<string, number>();
  #forgotten = Number.NEGATIVE_INFINITY;

  get size(): number {
    return this.#ends.size;
  }

  remember(scope: string): void {
    const now = monotonicNow();
    this.#ends.delete(scope);
    this.#ends.set(scope, now);
    for (const [oldest, at] of this.#ends) {
      if (now - at <= REMEMBER_ENDS_MS && this.#ends.size <= MAX_REMEMBERED_ENDS) break;
      this.#forgotten = Math.max(this.#forgotten, at);
      this.#ends.delete(oldest);
    }
  }

  /** `ended` when one of `scopes` ended at or after `moment`, `unknown` when entries from after it are already forgotten. */
  since(scopes: readonly string[], moment: number): 'ended' | 'unknown' | 'none' {
    const ended = Math.max(...scopes.map((scope) => this.#ends.get(scope) ?? Number.NEGATIVE_INFINITY));
    if (ended >= moment) return 'ended';
    return moment <= this.#forgotten ? 'unknown' : 'none';
  }
}

/** How long a stream lives when nothing says otherwise (`LIVE_MAX_STREAM_SECONDS`). */
export const MAX_STREAM_SECONDS = 900;

/** The headers of a live stream: an event stream, never cached, transformed or buffered on its way (nginx: X-Accel-Buffering). */
export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store, no-transform',
  'x-accel-buffering': 'no',
};

const encoder = new TextEncoder();

/** An event of the stream: `event:`, `id:`, `data:` (one line — JSON) and the blank line that ends it. */
const event = (name: string, data: unknown, id?: string) => `event: ${name}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;

/** The frame that tells a tab its sign-in is over: it stops and does not connect again. */
export const END_FRAME = event('end', {});

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
  readonly accounts: readonly string[] | undefined;
  readonly connection: string;
  readonly channels: ReadonlySet<string>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly #seqs = new Map<string, number>();
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  /** Hints that came before `hello` went out — sent after it, those newer than what it said. */
  #waiting: Extract<LiveMessage, { kind: 'refresh' }>[] | undefined = [];
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #lifetime: ReturnType<typeof setTimeout> | undefined;
  readonly #stop: () => void;

  constructor(request: LiveStreamRequest, onClose: () => void) {
    this.scope = request.scope;
    this.accounts = request.accounts;
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
  hello(seqs: readonly number[], lastEventId: string | null | undefined, { retryMs, heartbeatSeconds, maxStreamSeconds = MAX_STREAM_SECONDS }: Pick<LiveHubOptions, 'retryMs' | 'heartbeatSeconds' | 'maxStreamSeconds'>): void {
    // Closed while `hello` was prepared (the tab went away, the server closes): no heartbeat for a stream nobody reads.
    if (this.#closed) return;
    const channels = [...this.channels];
    channels.forEach((channel, index) => this.#seqs.set(channel, seqs[index] ?? 0));
    const seen = seenIn(lastEventId);
    const missed = channels.filter((channel) => seen.has(channel) && seen.get(channel) !== this.#seqs.get(channel));
    this.#write(`retry: ${retryMs}\n\n` + event('hello', { seq: Object.fromEntries(this.#seqs), ...(seen.size > 0 ? { missed } : {}) } satisfies LiveHello, eventId(this.#seqs)));
    const waiting = this.#waiting ?? [];
    this.#waiting = undefined;
    // Hints that came while `hello` was prepared: those it counted already are not told again (their sequence is at most its).
    for (const message of waiting) if (message.seq > (this.#seqs.get(message.channel) ?? 0)) this.hint(message);
    // A comment line now and then: proxies and load balancers close connections that stay silent.
    this.#heartbeat = setInterval(() => outsideTransaction(() => this.#write(': heartbeat\n\n')), heartbeatSeconds * 1000);
    this.#heartbeat.unref?.();
    // A stream does not live for ever: it closes after a while (a little earlier by chance, so the tabs of one deploy do not return
    // together) and its browser is checked again.
    this.#lifetime = setTimeout(() => this.reconnect(), maxStreamSeconds * 1000 * (0.75 + Math.random() * 0.25));
    this.#lifetime.unref?.();
  }

  /** A hint on one of its channels — never data. The connection that caused it gets it with nothing to reload. */
  hint(message: Extract<LiveMessage, { kind: 'refresh' }>): void {
    if (this.#closed || !this.channels.has(message.channel)) return;
    if (this.#waiting) return void this.#waiting.push(message);
    // After `hello` every hint is news: the backend delivers each refresh once, in the order of its sequence. One with a lower
    // sequence than the stream saw means the channel's counter started again (its key expired after a day without hints, was
    // evicted or flushed; the memory backend forgot it) — told, never dropped as "old".
    this.#seqs.set(message.channel, message.seq);
    const hint: LiveHint = { channel: message.channel, only: message.except === this.connection ? [] : message.only, seq: message.seq };
    this.#write(event('refresh', hint, eventId(this.#seqs)));
  }

  /** The account's sign-ins changed: the stream closes without `end`, and the browser connects again after a random pause — and is checked. */
  reconnect(): void {
    if (this.#closed) return;
    this.#write(`retry: ${1000 + Math.floor(Math.random() * 9000)}\n\n`);
    this.close();
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
    clearTimeout(this.#lifetime);
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
const refuse = (status: number, message: string, retryAfterSeconds: string) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': retryAfterSeconds } });

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
 * The live streams of this process: it opens them, hands each the hints of its channels as the backend delivers them,
 * closes those of a session that ended (signed in or out — in any process) and all of them when the server closes. A
 * process holds at most `maxStreams`, a session at most `maxStreamsPerSession` of them.
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
  /** Keyed account scope (or `'*'`) → when its sign-ins last ended: a stream opened on an answer from before it is closed again. */
  readonly #recentEnds = new RecentEnds();
  /** Session scope → when that session last ended: a stream opened on a session read from before it is ended again. */
  readonly #recentSessionEnds = new RecentEnds();
  /** Keyed account scope → its streams (those opened by a signed-in browser). */
  readonly #accounts = new Map<string, Set<OpenStream>>();
  #listening: Promise<unknown> | undefined;
  /** When the backend began to deliver ends to this hub (after the subscription answered); an end before it was seen by nobody. */
  #listeningSince = Number.POSITIVE_INFINITY;
  #closed = false;

  /** `redactor` masks a failure's text in the log — the app's, so the names and patterns it adds count. */
  constructor(backend: LiveBackend, options: LiveHubOptions, logger: Logger, closing: AbortSignal | undefined, redactor: Redactor) {
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
    for (const account of stream.accounts ?? []) index(this.#accounts, account, stream);
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
      if (request.checkedAt !== undefined) {
        // An end before the hub listened was neither delivered nor remembered: it cannot be ruled out, whatever the memory says.
        const blind = request.checkedAt < this.#listeningSince;
        // The session ended after it was read: nothing is left to reconnect to, so the stream ends, as any stream of that session did.
        // An end older than the memory cannot be ruled out: the browser asks again, and its next request reads the session anew.
        const session = this.#recentSessionEnds.since([stream.scope], request.checkedAt);
        if (session === 'ended') stream.end();
        else if (session === 'unknown' || blind) stream.reconnect();
        // The sign-in was asked about before an end of this account arrived: the answer may be stale, so ask again after a pause.
        else if (stream.accounts !== undefined && this.#recentEnds.since(['*', ...stream.accounts], request.checkedAt) !== 'none') stream.reconnect();
      }
    } catch (error) {
      stream.close();
      this.#logger.error('A live stream could not start (the live backend failed)', { exception: this.#redactor.text(String(error)) });
      return refuse(503, 'Live updates are unavailable.', '5');
    }
    return new Response(stream.readable, { status: 200, headers: STREAM_HEADERS });
  }

  /**
   * Subscribes to the backend now (the first stream does it otherwise). Ends that come before it are seen by nobody, so a stream
   * whose session was read earlier is asked to connect again.
   */
  async listen(): Promise<void> {
    await this.#listen();
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

  /** The number of ends remembered, for tests. */
  get endsRemembered(): number {
    return this.#recentEnds.size;
  }

  /** The number of session ends remembered, for tests. */
  get sessionEndsRemembered(): number {
    return this.#recentSessionEnds.size;
  }

  #forget(stream: OpenStream): void {
    this.#streams.delete(stream);
    unindex(this.#sessions, stream.scope, stream);
    for (const account of stream.accounts ?? []) unindex(this.#accounts, account, stream);
    for (const channel of stream.channels) unindex(this.#channels, channel, stream);
  }

  #listen(): Promise<unknown> {
    this.#listening ??= this.#backend
      .listen((message) => outsideTransaction(() => this.#deliver(message)))
      .then((value) => {
        this.#listeningSince = Math.min(this.#listeningSince, monotonicNow());
        return value;
      })
      .catch((error: unknown) => {
        this.#listening = undefined;
        this.#listeningSince = Number.POSITIVE_INFINITY;
        throw error;
      });
    return this.#listening;
  }

  #deliver(message: LiveMessage): void {
    if (message.kind === 'end') {
      // Remembered for a stream that is still opening: the account ends apart from the session ends, so a flood of sign-outs never pushes an account out.
      if (message.scope === '*' || message.scope.startsWith(ACCOUNT_PREFIX)) this.#recentEnds.remember(message.scope);
      else this.#recentSessionEnds.remember(message.scope);
      // A stream that ends leaves its set meanwhile — copied first. A session scope and an account scope never collide (keyed apart);
      // `'*'` is every account's streams, guests' stay.
      for (const stream of [...(this.#sessions.get(message.scope) ?? [])]) stream.end();
      // A stream stands under every key's scope, so `'*'` meets it once per scope: a Set keeps it to once.
      const accounts = message.scope === '*' ? new Set([...this.#accounts.values()].flatMap((set) => [...set])) : [...(this.#accounts.get(message.scope) ?? [])];
      for (const stream of accounts) stream.reconnect();
      return;
    }
    // A stream that breaks while written to leaves the set meanwhile — a Set goes on with the next one.
    for (const stream of this.#channels.get(message.channel) ?? []) stream.hint(message);
  }
}
