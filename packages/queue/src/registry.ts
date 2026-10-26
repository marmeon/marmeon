import { durationToSeconds, type Duration } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { JobClass } from './job.ts';

/** The queue is set up wrongly: a job without a name, a name used twice, a timeout the connection cannot hold … — said at startup. */
export class QueueSetupError extends Error {
  override name = 'QueueSetupError';
}

/** A job could not be dispatched — its payload does not match its schema, or the job is not registered. */
export class QueueError extends Error {
  override name = 'QueueError';
}

/** `auth.send-welcome-mail`, `billing:invoice.send` — lower case, digits, and `.`, `-`, `_`, `:` between parts. */
const NAME = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

/** Names under `marmeon.` belong to the framework's own jobs (queued mails and listeners). */
export const FRAMEWORK_PREFIX = 'marmeon.';

/**
 * Which job class has which name — from the modules' `jobs: [...]`. The worker finds a job's class here, so a job
 * that is not registered cannot run: dispatching it is an error, and a name used twice fails the start.
 */
export class JobRegistry {
  readonly #jobs = new Map<string, { readonly job: JobClass; readonly source: string }>();

  /** @internal Registers job classes; `source` names where they come from in errors (`module auth`). */
  add(jobs: readonly JobClass[], source: string, options: { framework?: boolean } = {}): this {
    for (const job of jobs) {
      const name = checkJobClass(job, source);
      if (name.startsWith(FRAMEWORK_PREFIX) && !options.framework) {
        throw new QueueSetupError(withCode('Q4', `${job.name} (${source}) is named "${name}" — names under "${FRAMEWORK_PREFIX}" belong to the framework. Choose another static job.`));
      }
      const existing = this.#jobs.get(name);
      if (existing && existing.job !== job) {
        throw new QueueSetupError(
          withCode(
            'Q4',
            `Two jobs are named "${name}": ${existing.job.name} (${existing.source}) and ${job.name} (${source}). A job's name is how the queue finds its class — give each its own static job.`,
          ),
        );
      }
      this.#jobs.set(name, { job, source });
    }
    return this;
  }

  get(name: string): JobClass | undefined {
    return this.#jobs.get(name)?.job;
  }

  /** Whether exactly this class is registered under its name. */
  has(job: JobClass): boolean {
    return this.#jobs.get(job.job)?.job === job;
  }

  all(): JobClass[] {
    return [...this.#jobs.values()].map((entry) => entry.job);
  }
}

/** The job's name, after checking the class has what a job needs. */
export function checkJobClass(job: JobClass, source: string): string {
  const label = typeof job === 'function' && job.name ? job.name : String(job);
  if (typeof job !== 'function') throw new QueueSetupError(withCode('Q4', `${source} lists ${label} as a job, but it is not a class.`));
  if (typeof job.job !== 'string' || !NAME.test(job.job)) {
    throw new QueueSetupError(
      withCode(
        'Q4',
        `${label} (${source}) needs a stable name: static job = 'module.what-it-does' (lower case; letters, digits and . - _ : between parts) — never the class name, which changes with refactoring.` +
          (typeof job.job === 'string' ? ` "${job.job}" is not one.` : ''),
      ),
    );
  }
  if (typeof job.schema?.['~standard']?.validate !== 'function') {
    throw new QueueSetupError(withCode('Q4', `${label} (${job.job}, ${source}) needs static schema — a Standard Schema of its payload, e.g. v.object({ userId: v.number() }).`));
  }
  if (typeof job.prototype?.handle !== 'function') throw new QueueSetupError(withCode('Q4', `${label} (${job.job}, ${source}) needs a handle(payload, job) method.`));
  const { tries, timeout, backoff } = job;
  const timeoutValue = timeout === undefined ? undefined : spanSeconds(timeout);
  if (tries !== undefined && (!Number.isInteger(tries) || tries < 1)) throw new QueueSetupError(withCode('Q4', `${label}: static tries must be a whole number ≥ 1, not ${String(tries)}.`));
  if (timeout !== undefined && !(timeoutValue !== undefined && timeoutValue > 0)) throw new QueueSetupError(withCode('Q4', `${label}: static timeout must be seconds > 0 or a duration like { minutes: 2 }, not ${JSON.stringify(timeout)}.`));
  if (backoff !== undefined && backoffSeconds(backoff) === undefined) {
    throw new QueueSetupError(withCode('Q4', `${label}: static backoff must be seconds ≥ 0 — a number, a duration like { minutes: 1 }, or a list like [10, { minutes: 1 }, 300].`));
  }
  const { middleware } = job;
  if (middleware !== undefined && (!Array.isArray(middleware) || middleware.some((layer) => typeof (layer as { handle?: unknown } | null)?.handle !== 'function'))) {
    throw new QueueSetupError(withCode('Q4', `${label}: static middleware must be a list of job middleware — objects with handle(context, next), like withoutOverlapping(…).`));
  }
  return job.job;
}

/** Defaults of a job class's retry settings. */
export const DEFAULT_TIMEOUT = 60;

export function triesOf(job: JobClass): number {
  return job.tries ?? 1;
}

/** The seconds before each retry, normalised from numbers and durations — the unit the job record stores. */
export function backoffOf(job: JobClass): number[] {
  return job.backoff === undefined ? [] : (backoffSeconds(job.backoff) ?? []);
}

export function timeoutOf(job: JobClass): number {
  return job.timeout === undefined ? DEFAULT_TIMEOUT : (spanSeconds(job.timeout) ?? DEFAULT_TIMEOUT);
}

/** The seconds of a span given as seconds or as a duration, or `undefined` when it is neither. */
export function spanSeconds(value: unknown): number | undefined {
  try {
    const seconds = durationToSeconds(value as Duration);
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** The seconds before each retry, or `undefined` when `backoff` is not a duration or a list of them (or one is negative). */
export function backoffSeconds(backoff: unknown): number[] | undefined {
  const list: unknown[] = Array.isArray(backoff) ? backoff : [backoff];
  const seconds = list.map(spanSeconds);
  return seconds.every((value) => value !== undefined && value >= 0) ? (seconds as number[]) : undefined;
}
