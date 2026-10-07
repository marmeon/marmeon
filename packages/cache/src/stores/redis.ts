import { createHash } from 'node:crypto';
import { SystemClock, type Clock } from '@marmeon/core';
import type { RedisConnection, RedisScript } from '@marmeon/redis';
import type { CacheStore, Entry } from '../cache.ts';

/** A named Lua script (the shape of `defineRedisScript` — built here, as @marmeon/redis is an optional peer). */
function script(name: string, lua: string): RedisScript {
  return Object.freeze({ name, lua, sha: createHash('sha1').update(lua).digest('hex') });
}

/** KEYS[1] counter, ARGV[1] by, ARGV[2] ms until a new counter expires ('' = never). A live integer keeps its TTL. */
const INCREMENT = script(
  'cache.increment',
  `local current = redis.call('get', KEYS[1])
if current and string.match(current, '^%-?%d+$') then
  return redis.call('incrby', KEYS[1], ARGV[1])
end
if ARGV[2] == '' then redis.call('set', KEYS[1], ARGV[1]) else redis.call('set', KEYS[1], ARGV[1], 'px', ARGV[2]) end
return tonumber(ARGV[1])`,
);

/** KEYS[1] lock, ARGV[1] owner, ARGV[2] ms. Free → taken; this owner's → extended; another's → untouched. */
const LOCK = script(
  'cache.lock',
  `local owner = redis.call('get', KEYS[1])
if owner == false or owner == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[1], 'px', ARGV[2])
  return 1
end
return 0`,
);

/** KEYS[1] lock, ARGV[1] owner: deleted only while it is this owner's — an expired lock taken over by another stays. */
const UNLOCK = script(
  'cache.unlock',
  `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`,
);

/** The connection, now or on first use (the store is built before the Redis package's provider boots). */
export type RedisStoreConnection = RedisConnection | (() => Promise<RedisConnection>);

/**
 * The cache in Redis (`CACHE_DRIVER=redis`): `<prefix>cache:<key>` holds the value as JSON, expiry is Redis' own
 * (`PX`, real time — `app.travel()` does not move it); locks are `<prefix>lock:<name>` holding the owner token.
 * `add` and locks are `SET NX PX`; `increment` and releasing a lock are Lua scripts — one atomic step each.
 */
export class RedisStore implements CacheStore {
  readonly #connection: () => Promise<RedisConnection>;
  readonly #clock: Clock;

  constructor(connection: RedisStoreConnection, clock: Clock = new SystemClock()) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
    this.#clock = clock;
  }

  async read(key: string): Promise<Entry | undefined> {
    const redis = await this.#connection();
    const name = redis.key(`cache:${key}`);
    const [value, ttl] = await Promise.all([redis.command<string | null>(['GET', name]), redis.command<number>(['PTTL', name])]);
    if (value === null || ttl === -2) return undefined; // -2: expired between the two replies
    return { value: JSON.parse(value) as unknown, expires: ttl >= 0 ? this.#clock.now() + ttl : null };
  }

  async write(key: string, entry: Entry): Promise<void> {
    const redis = await this.#connection();
    const name = redis.key(`cache:${key}`);
    const ms = this.#remaining(entry.expires);
    if (ms === undefined) await redis.command(['SET', name, serialize(entry.value)]);
    else if (ms <= 0) await redis.command(['DEL', name]); // already expired
    else await redis.command(['SET', name, serialize(entry.value), 'PX', ms]);
  }

  async add(key: string, entry: Entry): Promise<boolean> {
    const redis = await this.#connection();
    const ms = this.#remaining(entry.expires);
    const args = ['SET', redis.key(`cache:${key}`), serialize(entry.value), 'NX', ...(ms === undefined ? [] : ['PX', Math.max(1, ms)])];
    return (await redis.command(args)) === 'OK';
  }

  async increment(key: string, by: number, expires: number | null): Promise<number> {
    const redis = await this.#connection();
    const ms = this.#remaining(expires);
    return Number(await redis.run(INCREMENT, [redis.key(`cache:${key}`)], [by, ms === undefined ? '' : Math.max(1, ms)]));
  }

  async delete(key: string): Promise<void> {
    const redis = await this.#connection();
    await redis.command(['DEL', redis.key(`cache:${key}`)]);
  }

  async clear(): Promise<void> {
    // Only this cache's keys (never FLUSHDB: sessions, queues and locks may share the database), in batches.
    const redis = await this.#connection();
    let cursor = '0';
    do {
      const [next, keys] = await redis.command<[string, string[]]>(['SCAN', cursor, 'MATCH', `${escapeGlob(redis.key('cache:'))}*`, 'COUNT', 500]);
      cursor = next;
      if (keys.length > 0) await redis.command(['UNLINK', ...keys]);
    } while (cursor !== '0');
  }

  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    const redis = await this.#connection();
    return Number(await redis.run(LOCK, [redis.key(`lock:${name}`)], [owner, Math.max(1, expires - this.#clock.now())])) === 1;
  }

  async unlock(name: string, owner: string): Promise<boolean> {
    const redis = await this.#connection();
    return Number(await redis.run(UNLOCK, [redis.key(`lock:${name}`)], [owner])) === 1;
  }

  async forceUnlock(name: string): Promise<void> {
    const redis = await this.#connection();
    await redis.command(['DEL', redis.key(`lock:${name}`)]);
  }

  async lockOwner(name: string): Promise<string | undefined> {
    const redis = await this.#connection();
    return (await redis.command<string | null>(['GET', redis.key(`lock:${name}`)])) ?? undefined;
  }

  /** Milliseconds from now until `expires`; undefined = never. */
  #remaining(expires: number | null): number | undefined {
    return expires === null ? undefined : Math.ceil(expires - this.#clock.now());
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** A key as a literal in a `SCAN MATCH` pattern. */
function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, (character) => `\\${character}`);
}
