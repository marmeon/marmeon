import type { RedisConnection } from '@bespokecore/redis';
import type { SessionPayload, SessionStore } from '../store.ts';

/** The connection, now or on first use (the store is built before the Redis package's provider boots). */
export type RedisSessionConnection = RedisConnection | (() => Promise<RedisConnection>);

/**
 * Sessions in Redis (`SESSION_DRIVER=redis`): `<prefix>session:<id>` holds the data as JSON and expires on its own
 * (`EX`, Redis' clock — `app.travel()` does not move it), so `gc` has nothing to do. Writing back is `SET … XX`: it
 * only replaces a key that still exists — a session a sign-out deleted meanwhile stays deleted.
 */
export class RedisSessionStore implements SessionStore {
  readonly #connection: () => Promise<RedisConnection>;

  constructor(connection: RedisSessionConnection) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
  }

  async read(id: string): Promise<SessionPayload | undefined> {
    const redis = await this.#connection();
    const value = await redis.command<string | null>(['GET', redis.key(`session:${id}`)]);
    return value === null ? undefined : (JSON.parse(value) as SessionPayload);
  }

  async write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    const redis = await this.#connection();
    const key = redis.key(`session:${id}`);
    if (lifetimeSeconds <= 0) await redis.command(['DEL', key]); // already expired
    else await redis.command(['SET', key, JSON.stringify(data), 'EX', Math.ceil(lifetimeSeconds)]);
  }

  async writeIfExists(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<boolean> {
    const redis = await this.#connection();
    const key = redis.key(`session:${id}`);
    if (lifetimeSeconds <= 0) {
      await redis.command(['DEL', key]); // written back already expired: gone
      return false;
    }
    return (await redis.command<string | null>(['SET', key, JSON.stringify(data), 'XX', 'EX', Math.ceil(lifetimeSeconds)])) === 'OK';
  }

  async destroy(id: string): Promise<void> {
    const redis = await this.#connection();
    await redis.command(['DEL', redis.key(`session:${id}`)]);
  }

  async gc(): Promise<number> {
    return 0; // Redis expires sessions itself
  }
}
