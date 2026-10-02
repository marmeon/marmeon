import type { Duration, StandardSchemaV1 } from '@bespokecore/core';

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

/** Whether `T` survives `JSON.stringify` → `JSON.parse` unchanged (optional properties may be left out). */
type IsJson<T> = 0 extends 1 & T ? true : false extends JsonMember<T> ? false : true;
/** Per member of a union (distributive): `{ id: number } | null` is JSON, `string | Date` is not. */
type JsonMember<T> = T extends string | number | boolean | null
  ? true
  : T extends readonly (infer E)[]
    ? IsJson<E>
    : T extends Date | RegExp | Map<any, any> | Set<any> | ((...args: any[]) => any) | bigint | symbol | undefined
      ? false
      : T extends object
        ? false extends { [K in keyof T]-?: IsJson<Exclude<T[K], undefined>> }[keyof T]
          ? false
          : true
        : false;

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
}
