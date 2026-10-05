/**
 * Where hints travel (E89): from the process that refreshes a channel to every process with a stream on it. `memory` — one
 * process (development, tests, a single server); `redis` — Redis pub/sub, every process of the app. Each channel counts its
 * hints (`seq`), so a stream that was away knows whether it missed one (E104).
 */

/** What goes over the backend: a hint — or a session that ended (its streams close, everywhere). */
export type LiveMessage =
  | {
      readonly kind: 'refresh';
      readonly channel: string;
      readonly only: readonly string[] | null;
      readonly seq: number;
      /** The connection that caused it (`x-bespoke-connection`): it gets the hint with nothing to reload. */
      readonly except?: string | undefined;
    }
  | { readonly kind: 'end'; readonly scope: string };

export interface LiveBackend {
  /** Counts the channel's sequence up and sends the hint to every process — in that order, atomically. Returns the seq. */
  refresh(channel: string, only: readonly string[] | null, except: string | undefined): Promise<number>;
  /** The session of `scope` ended (signed out, signed in): every process closes its streams. */
  end(scope: string): Promise<void>;
  /** The current sequence of each channel (0: no hint yet, or forgotten). */
  seqs(channels: readonly string[]): Promise<number[]>;
  /** Hears every message — the first call starts listening (Redis: a connection of its own). Returns the function that stops. */
  listen(listener: (message: LiveMessage) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** How the memory backend bounds what it remembers of channels — like Redis's TTL on the sequence keys. */
export interface MemoryLiveOptions {
  /** Channels whose sequence it keeps at most — beyond, the one hinted longest ago is forgotten first (default 10 000). */
  readonly maxChannels?: number | undefined;
  /** How long it keeps a channel's sequence after its last hint, in ms (default a day — as Redis does). */
  readonly ttlMs?: number | undefined;
  /** The clock (tests). */
  readonly now?: (() => number) | undefined;
}

/**
 * One process: hints go straight to the streams of this process. The default — and what tests use.
 *
 * The sequences are bounded (W9 step 4): a channel's is forgotten a day after its last hint, and beyond `maxChannels` the one
 * hinted longest ago goes first — an app with a channel per record would otherwise grow the map for as long as the process
 * lives. A forgotten channel counts on from above every sequence ever forgotten, so a stream still open (one that saw a
 * higher number) never takes its next hint for an old one; a stream that reconnects sees "changed" and reloads once (E104).
 */
export class MemoryLiveBackend implements LiveBackend {
  /** Channel → its sequence and when it was last hinted, the one hinted longest ago first (a Map keeps insertion order). */
  readonly #seqs = new Map<string, { readonly seq: number; readonly at: number }>();
  readonly #listeners = new Set<(message: LiveMessage) => void>();
  readonly #max: number;
  readonly #ttl: number;
  readonly #now: () => number;
  /** The highest sequence forgotten — a channel that starts again counts on from here. */
  #floor = 0;

  constructor({ maxChannels = 10_000, ttlMs = 86_400_000, now = Date.now }: MemoryLiveOptions = {}) {
    this.#max = maxChannels;
    this.#ttl = ttlMs;
    this.#now = now;
  }

  async refresh(channel: string, only: readonly string[] | null, except: string | undefined): Promise<number> {
    const now = this.#now();
    this.#expire(now);
    const seq = (this.#seqs.get(channel)?.seq ?? this.#floor) + 1;
    // Last hinted now: to the end of the map.
    this.#seqs.delete(channel);
    this.#seqs.set(channel, { seq, at: now });
    for (const [oldest] of this.#seqs) {
      if (this.#seqs.size <= this.#max) break;
      this.#forget(oldest);
    }
    this.#send({ kind: 'refresh', channel, only, seq, ...(except === undefined ? {} : { except }) });
    return seq;
  }

  async end(scope: string): Promise<void> {
    this.#send({ kind: 'end', scope });
  }

  async seqs(channels: readonly string[]): Promise<number[]> {
    this.#expire(this.#now());
    return channels.map((channel) => this.#seqs.get(channel)?.seq ?? 0);
  }

  async listen(listener: (message: LiveMessage) => void): Promise<() => Promise<void>> {
    this.#listeners.add(listener);
    return async () => void this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }

  /** Forgets the channels last hinted longer than the TTL ago — they are at the front of the map. */
  #expire(now: number): void {
    for (const [channel, { at }] of this.#seqs) {
      if (now - at < this.#ttl) break;
      this.#forget(channel);
    }
  }

  #forget(channel: string): void {
    this.#floor = Math.max(this.#floor, this.#seqs.get(channel)?.seq ?? 0);
    this.#seqs.delete(channel);
  }

  #send(message: LiveMessage): void {
    for (const listener of [...this.#listeners]) listener(message);
  }
}

/** A message as JSON — refused (undefined) when it is not one this package sends. */
export function parseMessage(text: string): LiveMessage | undefined {
  try {
    const message = JSON.parse(text) as Partial<{ kind: string; channel: unknown; only: unknown; seq: unknown; except: unknown; scope: unknown }>;
    if (message.kind === 'end' && typeof message.scope === 'string') return { kind: 'end', scope: message.scope };
    if (
      message.kind === 'refresh' &&
      typeof message.channel === 'string' &&
      typeof message.seq === 'number' &&
      (message.only === null || (Array.isArray(message.only) && message.only.every((name) => typeof name === 'string'))) &&
      (message.except === undefined || typeof message.except === 'string')
    ) {
      return { kind: 'refresh', channel: message.channel, only: message.only as readonly string[] | null, seq: message.seq, ...(message.except === undefined ? {} : { except: message.except as string }) };
    }
  } catch {
    // Not JSON: not ours.
  }
  return undefined;
}
