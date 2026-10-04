import { createHash } from 'node:crypto';
import type { RedisConnection, RedisScript } from '@bespokecore/redis';
import type { SessionStore, SessionWrite, SessionWriteResult, StoredSession } from '../store.ts';

/** A named Lua script (the shape of `defineRedisScript` — built here, as @bespokecore/redis is an optional peer). */
function script(name: string, lua: string): RedisScript {
  return Object.freeze({ name, lua, sha: createHash('sha1').update(lua).digest('hex') });
}

/**
 * KEYS[1] session hash; ARGV[1] expected version ('' = a new key), ARGV[2] payload, ARGV[3] seconds to live. One atomic step:
 * compare the version, write the payload with version + 1, renew the expiry.
 */
const WRITE = script(
  'session.write',
  `local current = redis.call('hget', KEYS[1], 'v')
if ARGV[1] == '' then
  if current then return 'conflict' end
  current = '0'
elseif not current then
  return 'gone'
elseif current ~= ARGV[1] then
  return 'conflict'
end
redis.call('hset', KEYS[1], 'v', tostring(tonumber(current) + 1), 'd', ARGV[2])
redis.call('expire', KEYS[1], ARGV[3])
return 'written'`,
);

/** The connection, now or on first use (the store is built before the Redis package's provider boots). */
export type RedisSessionConnection = RedisConnection | (() => Promise<RedisConnection>);

/**
 * Sessions in Redis (`SESSION_DRIVER=redis`): `<prefix>session:<key>` (the SHA-256 of the session id, E144) is a hash holding
 * the payload (`d`) and its version (`v`) and expires on its own (`EXPIRE`, Redis' clock — `app.travel()` does not move it),
 * so `gc` has nothing to do. Writing is a Lua script — compare the version, write, renew — one atomic step (E145): a session a
 * sign-out deleted meanwhile stays deleted, one another request wrote meanwhile is a conflict.
 */
export class RedisSessionStore implements SessionStore {
  readonly #connection: () => Promise<RedisConnection>;

  constructor(connection: RedisSessionConnection) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
  }

  async read(key: string): Promise<StoredSession | undefined> {
    const redis = await this.#connection();
    const [version, data] = await redis.command<[string | null, string | null]>(['HMGET', redis.key(`session:${key}`), 'v', 'd']);
    return version === null || data === null ? undefined : { data, version: Number(version) };
  }

  async write(key: string, data: string, { expectedVersion, lifetimeSeconds }: SessionWrite): Promise<SessionWriteResult> {
    const redis = await this.#connection();
    const name = redis.key(`session:${key}`);
    if (lifetimeSeconds <= 0) {
      await redis.command(['DEL', name]); // written already expired: gone
      return expectedVersion === undefined ? 'written' : 'gone';
    }
    return redis.run<SessionWriteResult>(WRITE, [name], [expectedVersion ?? '', data, Math.ceil(lifetimeSeconds)]);
  }

  async destroy(key: string): Promise<void> {
    const redis = await this.#connection();
    await redis.command(['DEL', redis.key(`session:${key}`)]);
  }

  async gc(): Promise<number> {
    return 0; // Redis expires sessions itself
  }
}
