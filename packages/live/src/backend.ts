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

/** One process: hints go straight to the streams of this process. The default — and what tests use. */
export class MemoryLiveBackend implements LiveBackend {
  readonly #seqs = new Map<string, number>();
  readonly #listeners = new Set<(message: LiveMessage) => void>();

  async refresh(channel: string, only: readonly string[] | null, except: string | undefined): Promise<number> {
    const seq = (this.#seqs.get(channel) ?? 0) + 1;
    this.#seqs.set(channel, seq);
    this.#send({ kind: 'refresh', channel, only, seq, ...(except === undefined ? {} : { except }) });
    return seq;
  }

  async end(scope: string): Promise<void> {
    this.#send({ kind: 'end', scope });
  }

  async seqs(channels: readonly string[]): Promise<number[]> {
    return channels.map((channel) => this.#seqs.get(channel) ?? 0);
  }

  async listen(listener: (message: LiveMessage) => void): Promise<() => Promise<void>> {
    this.#listeners.add(listener);
    return async () => void this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
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
