import { SystemClock, type Clock } from '@bespokecore/core';
import type { RedisConnection, RedisScript } from '@bespokecore/redis';
import type { QueueCounts, QueuedPush, QueueDriver, ReservedJob } from '../driver.ts';

/**
 * Moves the due members of the sorted set `from` (score ≤ now) to the end of the list `to` — delayed jobs whose time has
 * come, claimed jobs whose claim expired (their worker died). Laravel's `migrateExpiredJobs`.
 */
const MIGRATE = `local function migrate(from, to, now)
  local due = redis.call('zrangebyscore', from, '-inf', now)
  if #due > 0 then
    redis.call('zremrangebyrank', from, 0, #due - 1)
    for i = 1, #due, 100 do
      redis.call('rpush', to, unpack(due, i, math.min(i + 99, #due)))
    end
  end
end
`;

/** Queues a member: into the list now, or into the delayed set until its time. And remembers the queue's name. */
const PUSH_ONE = `local function push(list, delayed, index, name, member, available, now)
  if tonumber(available) > tonumber(now) then
    redis.call('zadd', delayed, available, member)
  else
    redis.call('rpush', list, member)
  end
  redis.call('sadd', index, name)
end
`;

/**
 * The scripts, defined once per process with `defineRedisScript` (step 1: run by hash, loaded when Redis does not know
 * them). @bespokecore/redis is an optional peer of the queue — imported when the redis driver is first used.
 */
interface Scripts {
  readonly push: RedisScript;
  readonly reserve: RedisScript;
  readonly ack: RedisScript;
  readonly release: RedisScript;
  readonly size: RedisScript;
}
let scripts: Promise<Scripts> | undefined;

function loadScripts(): Promise<Scripts> {
  scripts ??= import('@bespokecore/redis').then(({ defineRedisScript }) => ({
    // KEYS: list, delayed, queue index. ARGV: queue name, member, available at (ms), now (ms).
    push: defineRedisScript(
      'queue.push',
      `${PUSH_ONE}push(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2], ARGV[3], ARGV[4])
return 1`,
    ),
    // KEYS: list, delayed, reserved. ARGV: now (ms), claim expiry (ms). The claim — migrate, pop, count the attempt,
    // record the claim — is one atomic step: two workers never pop the same member.
    reserve: defineRedisScript(
      'queue.reserve',
      `${MIGRATE}migrate(KEYS[2], KEYS[1], ARGV[1])
migrate(KEYS[3], KEYS[1], ARGV[1])
local member = redis.call('lpop', KEYS[1])
if not member then return false end
local id, attempts, payload = string.match(member, '^([^:]*):(%d+):(.*)$')
if not id then id, attempts, payload = '?', '0', member end
local claimed = id .. ':' .. (tonumber(attempts) + 1) .. ':' .. payload
redis.call('zadd', KEYS[3], ARGV[2], claimed)
return claimed`,
    ),
    // KEYS: reserved, queue index, then per next job: its list and delayed set. ARGV: member, now, then per next job:
    // queue name, member, available at. Acknowledged and the chain handed on together — only for this claim.
    ack: defineRedisScript(
      'queue.ack',
      `${PUSH_ONE}if redis.call('zrem', KEYS[1], ARGV[1]) == 0 then return 0 end
local count = (#KEYS - 2) / 2
for i = 1, count do
  push(KEYS[1 + 2 * i], KEYS[2 + 2 * i], KEYS[2], ARGV[3 * i], ARGV[3 * i + 1], ARGV[3 * i + 2], ARGV[2])
end
return 1`,
    ),
    // KEYS: reserved, delayed. ARGV: member, available at. Back to the queue — only for this claim; the attempt stays counted.
    release: defineRedisScript(
      'queue.release',
      `if redis.call('zrem', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('zadd', KEYS[2], ARGV[2], ARGV[1])
return 1`,
    ),
    // KEYS: list, delayed, reserved.
    size: defineRedisScript('queue.size', `return redis.call('llen', KEYS[1]) + redis.call('zcard', KEYS[2]) + redis.call('zcard', KEYS[3])`),
  }));
  return scripts;
}

/** The connection, now or on first use (the driver is built before the Redis package's provider boots). */
export type RedisQueueConnection = RedisConnection | (() => Promise<RedisConnection>);

/**
 * Jobs in Redis (`QUEUE_CONNECTION=redis`, E83) — Laravel's model:
 *
 * - `<prefix>queues:<queue>` — a list of waiting jobs, oldest first;
 * - `<prefix>queues:<queue>:delayed` — a sorted set of jobs not yet due (score: when they are), and of released ones;
 * - `<prefix>queues:<queue>:reserved` — a sorted set of claimed jobs (score: when the claim expires = now + `retryAfter`);
 * - `<prefix>queues` — the names of the queues (`--queue=*`, `queue:size`).
 *
 * A job is the member `<id>:<attempts>:<payload>`. **The claim is one Lua script:** it moves due delayed jobs and
 * expired claims (a worker that died) back to the list, pops the first job, counts the attempt and records the claim —
 * atomically, so two workers never hold the same job. Acknowledging removes exactly the claimed member: once a claim
 * expired and another worker took the job (`attempts` counted up: another member), a late ack, release or fail changes
 * nothing. Times come from the queue's {@link Clock} (passed to the scripts), like Laravel's — not from Redis.
 *
 * Redis cannot join a database transaction: a dispatch inside `connections.transaction()` is pushed after the commit and
 * dropped on a rollback (the `QueueManager` holds it, E85/E107).
 */
export class RedisQueueDriver implements QueueDriver {
  readonly #connection: () => Promise<RedisConnection>;
  readonly #clock: Clock;
  readonly #retryAfter: number;

  /** `retryAfter`: seconds after which a claimed job counts as abandoned (its worker died) and is claimed again. */
  constructor(connection: RedisQueueConnection, options: { retryAfter: number; clock?: Clock }) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
    this.#clock = options.clock ?? new SystemClock();
    this.#retryAfter = options.retryAfter;
  }

  async push(queue: string, payload: string, delay: number): Promise<string> {
    const [redis, { push }] = await Promise.all([this.#connection(), loadScripts()]);
    const id = crypto.randomUUID();
    const now = this.#clock.now();
    const keys = this.#keys(redis, queue);
    await redis.run(push, [keys.list, keys.delayed, redis.key('queues')], [queue, `${id}:0:${payload}`, now + Math.round(delay * 1000), now]);
    return id;
  }

  async reserve(queues: readonly string[]): Promise<ReservedJob | undefined> {
    const [redis, { reserve }] = await Promise.all([this.#connection(), loadScripts()]);
    for (const queue of queues) {
      const now = this.#clock.now();
      const keys = this.#keys(redis, queue);
      const member = await redis.run<string | null>(reserve, [keys.list, keys.delayed, keys.reserved], [now, now + this.#retryAfter * 1000]);
      if (typeof member !== 'string') continue;
      const { id, attempts, payload } = parseMember(member);
      return { id, queue, payload, attempts, reservedAt: now };
    }
    return undefined;
  }

  async ack(job: ReservedJob, next: readonly QueuedPush[] = []): Promise<boolean> {
    const [redis, { ack }] = await Promise.all([this.#connection(), loadScripts()]);
    const now = this.#clock.now();
    const keys = [this.#keys(redis, job.queue).reserved, redis.key('queues')];
    const args: (string | number)[] = [member(job), now];
    for (const push of next) {
      const target = this.#keys(redis, push.queue);
      keys.push(target.list, target.delayed);
      args.push(push.queue, `${crypto.randomUUID()}:0:${push.payload}`, now + Math.round(push.delay * 1000));
    }
    return Number(await redis.run(ack, keys, args)) === 1;
  }

  async release(job: ReservedJob, delay: number): Promise<boolean> {
    const [redis, { release }] = await Promise.all([this.#connection(), loadScripts()]);
    const keys = this.#keys(redis, job.queue);
    return Number(await redis.run(release, [keys.reserved, keys.delayed], [member(job), this.#clock.now() + Math.round(delay * 1000)])) === 1;
  }

  async fail(job: ReservedJob): Promise<boolean> {
    const redis = await this.#connection();
    return Number(await redis.command(['ZREM', this.#keys(redis, job.queue).reserved, member(job)])) === 1;
  }

  async size(queue: string): Promise<number> {
    const [redis, { size }] = await Promise.all([this.#connection(), loadScripts()]);
    const keys = this.#keys(redis, queue);
    return Number(await redis.run(size, [keys.list, keys.delayed, keys.reserved]));
  }

  async counts(queue: string): Promise<QueueCounts> {
    const redis = await this.#connection();
    const keys = this.#keys(redis, queue);
    const [ready, delayed, reserved] = await Promise.all([
      redis.command<number>(['LLEN', keys.list]),
      redis.command<number>(['ZCARD', keys.delayed]),
      redis.command<number>(['ZCARD', keys.reserved]),
    ]);
    return { ready: Number(ready), delayed: Number(delayed), reserved: Number(reserved) };
  }

  async queues(): Promise<string[]> {
    const redis = await this.#connection();
    return (await redis.command<string[]>(['SMEMBERS', redis.key('queues')])).sort();
  }

  #keys(redis: RedisConnection, queue: string) {
    const list = redis.key(`queues:${queue}`);
    return { list, delayed: `${list}:delayed`, reserved: `${list}:reserved` };
  }
}

/** The claimed member a job came from — `<id>:<attempts>:<payload>`, attempts as claimed (the claim's token). */
function member(job: ReservedJob): string {
  return `${job.id}:${job.attempts}:${job.payload}`;
}

function parseMember(value: string): { id: string; attempts: number; payload: string } {
  const first = value.indexOf(':');
  const second = value.indexOf(':', first + 1);
  return { id: value.slice(0, first), attempts: Number(value.slice(first + 1, second)), payload: value.slice(second + 1) };
}
