import type { Logger } from '@marmeon/core';
import type { RedisConnection, RedisScript } from '@marmeon/redis';
import { parseMessage, type LiveBackend, type LiveMessage } from './backend.ts';

/** How long Redis keeps a channel's sequence after its last hint — a stream away longer reloads once (unknown = changed). */
const SEQ_TTL_SECONDS = 86_400;

/**
 * Counts the channel's sequence up and publishes the hint with it — one step, so the order of the messages is the order of
 * the sequence. KEYS: the sequence, the pub/sub channel. ARGV: the TTL, the message up to its `seq`.
 */
const REFRESH = `
local seq = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('PUBLISH', KEYS[2], ARGV[2] .. seq .. '}')
return seq
`;

/** The parts of @marmeon/redis this backend uses (its module is an optional peer: imported when the driver is `redis`). */
export interface RedisLiveDependencies {
  readonly connection: RedisConnection;
  readonly script: (name: string, lua: string) => RedisScript;
  readonly logger: Logger;
}

/**
 * Redis pub/sub: every process of the app hears every hint and every session that ended, over one subscriber
 * connection per process; the sequences are Redis keys (`<prefix>live:seq:<channel>`, a day after the last hint).
 *
 * A hint published while Redis is unreachable is lost — the refresh logs it and the change stays without a hint; a stream that
 * reconnects later compares sequences and reloads only what it knows it missed.
 */
export class RedisLiveBackend implements LiveBackend {
  readonly #connection: RedisConnection;
  readonly #logger: Logger;
  readonly #refresh: RedisScript;
  readonly #channel: string;
  #subscriber: RedisConnection | undefined;
  #stop: Promise<() => Promise<void>> | undefined;
  readonly #listeners = new Set<(message: LiveMessage) => void>();

  constructor({ connection, script, logger }: RedisLiveDependencies) {
    this.#connection = connection;
    this.#logger = logger;
    this.#refresh = script('marmeon-live-refresh', REFRESH);
    this.#channel = connection.key('live');
  }

  async refresh(channel: string, only: readonly string[] | null, except: string | undefined): Promise<number> {
    const head = JSON.stringify({ kind: 'refresh', channel, only, ...(except === undefined ? {} : { except }) }).slice(0, -1) + ',"seq":';
    return Number(await this.#connection.run(this.#refresh, [this.#seqKey(channel), this.#channel], [SEQ_TTL_SECONDS, head]));
  }

  async end(scope: string): Promise<void> {
    await this.#connection.command(['PUBLISH', this.#channel, JSON.stringify({ kind: 'end', scope })]);
  }

  async seqs(channels: readonly string[]): Promise<number[]> {
    if (channels.length === 0) return [];
    const values = await this.#connection.command<(string | null)[]>(['MGET', ...channels.map((channel) => this.#seqKey(channel))]);
    return values.map((value) => (value === null ? 0 : Number(value)));
  }

  async listen(listener: (message: LiveMessage) => void): Promise<() => Promise<void>> {
    this.#listeners.add(listener);
    this.#stop ??= (async () => {
      this.#subscriber = this.#connection.duplicate();
      return this.#subscriber.subscribe(this.#channel, (text) => {
        const message = parseMessage(text);
        if (!message) return void this.#logger.warn('A live message that is not one was published on the live channel; ignored', { channel: this.#channel });
        for (const each of [...this.#listeners]) each(message);
      });
    })().catch((error: unknown) => {
      this.#stop = undefined;
      throw error;
    });
    await this.#stop;
    return async () => void this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
    const stop = await this.#stop?.catch(() => undefined);
    this.#stop = undefined;
    await stop?.().catch(() => undefined);
    await this.#subscriber?.close();
    this.#subscriber = undefined;
  }

  #seqKey(channel: string): string {
    return this.#connection.key(`live:seq:${channel}`);
  }
}
