import type { Cache } from '@bespokecore/cache';
import type { Duration, IsJson, StandardSchemaV1 } from '@bespokecore/core';

/**
 * What a job's `handle(payload, job)` gets besides its payload: who it is, which attempt this is, a signal that aborts
 * at the job's timeout, and how to end the attempt other than by returning or throwing.
 *
 * Delivery is at-least-once (E85): a job can run more than once — a worker may die after the work and before the
 * acknowledgement. `id` stays the same across every attempt and retry, so a job can recognize work it already did.
 */
export interface JobContext {
  /** The job's id — stable over retries (also after `bespoke queue:retry`). */
  readonly id: string;
  /** The job's stable name, `static job`. */
  readonly name: string;
  /** This attempt, from 1. */
  readonly attempt: number;
  /** How many attempts the job has in all (`static tries`, as dispatched). */
  readonly tries: number;
  readonly queue: string;
  readonly connection: string;
  /**
   * Aborts when the job's `timeout` is over (or the worker must stop). Pass it on — `fetch(url, { signal })`,
   * `db.execute(…, { signal })` — or check `signal.aborted` between steps: Node cannot stop a promise from outside.
   */
  readonly signal: AbortSignal;
  /** Ends the job without retrying and without a failed entry — e.g. its record is gone: `return job.discard('user no longer exists')`. */
  discard(reason?: string): void;
  /** Puts the job back, to run again after `delay` (seconds or a duration; default: now). The attempt counts. */
  release(delay?: number | Duration): void;
  /** Fails the job now — no more attempts, it goes to the failed jobs. */
  fail(reason: string | Error): void;
  /**
   * Runs `fn` — a side effect that must not repeat, like sending a mail — unless it already ran for `key` (E85): after
   * it succeeds, a marker for `key` goes into the app's cache (for `options.for` seconds, default a day), and a later
   * attempt, a retry or another job with the same key skips it. Resolves true when `fn` ran now, false when it was
   * skipped. The key is the app's: include an id, `welcome-mail:${user.id}`.
   *
   * ```ts
   * await job.once(`welcome-mail:${user.id}`, () => this.#mailer.send(new WelcomeMail(user)));
   * ```
   *
   * **Honest about the gap:** the marker is written after `fn` — a worker that dies between the two (after the mail
   * went out, before the marker) runs `fn` again on the next attempt. `once` makes repeats rare, not impossible:
   * delivery stays at-least-once. While one attempt runs `fn` for a key, another with the same key fails its attempt
   * (and retries) instead of running it alongside. Needs a cache (@bespokecore/cache) — `database` or `redis` when
   * workers run on several machines.
   */
  once(key: string, fn: () => unknown, options?: { readonly for?: number }): Promise<boolean>;
}

/** What a job middleware gets: the attempt's context and payload, and the app's cache (for locks). */
export interface JobMiddlewareContext<P = unknown> {
  readonly payload: P;
  readonly job: JobContext;
  /** The job's `timeout` in seconds. */
  readonly timeout: number;
  /** Seconds a claim holds before another worker may take the job again (`retryAfter`) — undefined on the sync connection. */
  readonly retryAfter: number | undefined;
  /** The app's `Cache` (@bespokecore/cache) — for locks across workers. */
  cache(): Promise<Cache>;
}

/**
 * Runs around a job's `handle()` (`static middleware = [...]`) — like HTTP middleware: call `next()` to run the job, or
 * end the attempt without it (`job.release(…)`, `job.discard(…)`). `withoutOverlapping(…)` is one.
 */
export interface JobMiddleware<P = any> {
  handle(context: JobMiddlewareContext<P>, next: () => Promise<void>): Promise<void>;
}

/** The input type of a Standard Schema — what a job is dispatched with. */
export type SchemaInput<S> = S extends StandardSchemaV1 ? NonNullable<S['~standard']['types']>['input'] : never;
/** The output type of a Standard Schema — what `handle()` gets. */
export type SchemaOutput<S> = S extends StandardSchemaV1 ? NonNullable<S['~standard']['types']>['output'] : never;

/** The static side of a job class (E84): a stable name, the payload's schema, and how it retries. */
export interface JobStatics {
  /** The job's stable name — what the queue stores, never the class name: `'auth.send-welcome-mail'`. */
  readonly job: string;
  /** The payload's schema (Standard Schema, e.g. Valibot) — checked when the job is dispatched *and* before it runs. */
  readonly schema: StandardSchemaV1;
  /** Attempts in all (default 1: no retry). */
  readonly tries?: number;
  /** Seconds before the next attempt — one value, or one per retry (the last repeats): `[10, 60, 300]`. Default 0. */
  readonly backoff?: number | readonly number[];
  /** Seconds an attempt may take (default 60): then `job.signal` aborts; a job that does not stop ends the worker. */
  readonly timeout?: number;
  /** Encrypt the payload in the queue (E105) — for payloads with secrets (tokens, signed links). Needs APP_KEY. */
  readonly encrypted?: boolean;
  /**
   * Runs around each attempt's `handle()`, first to last:
   *
   * ```ts
   * static readonly middleware = [withoutOverlapping<typeof RebuildStatsJob>((p) => `stats:${p.userId}`)];
   * ```
   */
  readonly middleware?: readonly JobMiddleware[];
}

/** An instance of a job: built per attempt through the container (constructor injection), then `handle(payload, job)`. */
export interface JobInstance {
  handle(payload: any, job: JobContext): void | Promise<void>;
}

/** A job class — a class with `static job`, `static schema` and `handle()`, like a controller. */
export type JobClass = JobStatics & (new (...args: any[]) => JobInstance);

/** What `handle()` of a job gets: the output of its `static schema`. `handle(payload: JobPayload<typeof SendWelcomeMailJob>, …)`. */
export type JobPayload<J extends JobStatics> = SchemaOutput<J['schema']>;

/** What a job is dispatched with: the input of its `static schema`. */
export type JobInput<J extends JobStatics> = SchemaInput<J['schema']>;

/**
 * Checks a job class where it is dispatched: its payload must be JSON, and `handle()` must take what the schema yields.
 * A failed check is a type whose name says what is wrong (message-as-type).
 */
export type CheckJob<J extends JobClass> =
  // Not a job class at all (no schema types to check): the parameter's own type says what is missing.
  unknown extends JobInput<J>
    ? unknown
    : IsJson<JobInput<J>> extends false
    ? {
        readonly 'A job payload is stored as JSON — its schema must describe JSON (strings, numbers, booleans, null, arrays, plain objects); pass IDs, not records, Dates or Maps': JobInput<J>;
      }
    : Parameters<InstanceType<J>['handle']> extends []
      ? unknown
      : JobPayload<J> extends Parameters<InstanceType<J>['handle']>[0]
        ? unknown
        : {
            readonly 'handle() expects another payload than static schema yields — type it as JobPayload<typeof YourJob>': {
              schema: JobPayload<J>;
              handle: Parameters<InstanceType<J>['handle']>[0];
            };
          };

/** One job of `queue.bulk([...])`: the class and its payload. */
export type PendingJob<J extends JobClass = JobClass> = readonly [job: J, payload: JobInput<J>];

/** Where and when a job is queued. */
export interface DispatchOptions {
  /** Run no earlier than this — seconds, or a duration (`{ minutes: 5 }`). */
  readonly delay?: number | Duration;
  /** The queue (default: the connection's, usually `default`). Workers take queues in the order `--queue=mail,default` lists them. */
  readonly queue?: string;
  /** The queue connection (default: `QUEUE_CONNECTION`). */
  readonly connection?: string;
  /** Only with `dispatch()`: see {@link UniqueDispatchOptions}. */
  readonly unique?: undefined;
}

/** Options of `bulk()` and `chain()`: where and when — never a unique key. */
export interface BatchOptions extends Omit<DispatchOptions, 'unique'> {
  readonly unique?: 'bulk() and chain() queue no unique jobs — dispatch them one by one';
}

/** What `dispatch()` resolves with: the job's id — or, for a unique dispatch, undefined when one with its key is queued already. */
export type DispatchResult<O> = O extends { readonly unique: string } ? string | undefined : string;

/**
 * A unique job (E85): while one with this key waits (or runs), dispatching another is a no-op — `dispatch()` resolves
 * `undefined` instead of an id. The key is held by a lock in the app's cache (`cache.lock`, @bespokecore/cache), taken
 * at the dispatch — outside any transaction, so other processes see it at once — and freed again when a transaction
 * around the dispatch rolls back (`afterRollback`), when the worker starts the job (`uniqueUntil: 'processing'`) or
 * when the job leaves the queue (`'done'`, the default: processed, failed, discarded).
 *
 * ```ts
 * await queue.dispatch(RebuildStatsJob, { userId }, { unique: `stats:${userId}`, uniqueFor: 600 });   // a second one: no-op
 * ```
 */
export interface UniqueDispatchOptions extends Omit<DispatchOptions, 'unique'> {
  /** The key (per job class): `stats:${userId}`. */
  readonly unique: string;
  /** Seconds (or a duration) the lock holds at most — then a lost or stuck job no longer blocks new ones. Default 3600. */
  readonly uniqueFor?: number | Duration;
  /** When the lock is freed: when a worker starts the job (`processing`), or when the job is done (`done`, default). */
  readonly uniqueUntil?: 'processing' | 'done';
}
