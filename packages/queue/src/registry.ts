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
 * Which job class has which name — from the modules' `jobs: [...]` and the providers' `static jobs`. The worker finds a
 * job's class here, so a job that is not registered cannot run: dispatching it is an error, and a name used twice fails the start.
 *
 * Apps may match the wording of the messages about a module's job or an `add()`ed one, so that wording stays. What only a
 * provider's job gets: safe names, and its source where those messages name none.
 */
export class JobRegistry {
  readonly #jobs = new Map<string, { readonly job: JobClass; readonly source: string; readonly provider: boolean }>();

  /** @internal Registers job classes; `source` names where they come from in errors (`module auth`). */
  add(jobs: readonly JobClass[], source: string, options: { framework?: boolean } = {}): this {
    return this.#register(jobs, source, options.framework === true, false);
  }

  /**
   * @internal Registers the `static jobs` of a provider (`provider MediaServiceProvider`), never as framework jobs.
   * Listing a registered class here changes nothing (a module and a provider, a provider twice).
   */
  addFromProvider(jobs: readonly JobClass[], source: string): this {
    return this.#register(jobs, source, false, true);
  }

  #register(jobs: readonly JobClass[], source: string, framework: boolean, provider: boolean): this {
    for (const job of jobs) {
      const name = checkJobClass(job, source, provider);
      if (name.startsWith(FRAMEWORK_PREFIX) && !framework) {
        throw new QueueSetupError(withCode('Q4', `${provider ? nameOf(job) : job.name} (${source}) is named "${name}" — names under "${FRAMEWORK_PREFIX}" belong to the framework. Choose another static job.`));
      }
      const existing = this.#jobs.get(name);
      if (existing && existing.job !== job) {
        const safe = provider || existing.provider;
        throw new QueueSetupError(
          withCode(
            'Q4',
            `Two jobs are named "${name}": ${safe ? nameOf(existing.job) : existing.job.name} (${existing.source}) and ${safe ? nameOf(job) : job.name} (${source}). A job's name is how the queue finds its class — give each its own static job.` +
              (safe ? ' Two classes with one name also come from an app that loads two copies of one package.' : ''),
          ),
        );
      }
      // A class listed again takes the new source (a duplicate names the last list), unless a provider's static is either of the two.
      if (!existing || (!provider && !existing.provider)) this.#jobs.set(name, { job, source, provider });
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

  /** @internal The source of `job` when it came from a provider's `static jobs`, for the messages that name a source only then. */
  providerSourceOf(job: JobClass): string | undefined {
    const entry = this.#jobs.get(job.job);
    return entry?.job === job && entry.provider ? entry.source : undefined;
  }

  all(): JobClass[] {
    return [...this.#jobs.values()].map((entry) => entry.job);
  }
}

/** @internal A class's or provider's name for a message: a non-empty string `name`, else `fallback` — never a symbol, a method or its source. */
export function nameOf(value: object, fallback = '(unnamed class)'): string {
  const { name } = value as { readonly name?: unknown };
  return typeof name === 'string' && name !== '' ? name : fallback;
}

/** What a value is, for a message: never the value itself, which may be a secret or a class's source. */
export function kindOf(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

/** The job's name, after checking the class has what a job needs. */
export function checkJobClass(job: JobClass, source: string, provider = false): string {
  // Safe names and the source for a provider's job only: see the class.
  if (provider && typeof job !== 'function') throw new QueueSetupError(withCode('Q4', `${source} lists a value of type ${kindOf(job)} as a job, but it is not a class.`));
  const label = provider ? nameOf(job) : typeof job === 'function' && job.name ? job.name : String(job);
  if (typeof job !== 'function') throw new QueueSetupError(withCode('Q4', `${source} lists ${label} as a job, but it is not a class.`));
  // Built only after `job.job` is known to be a string.
  const where = () => (provider ? ` (${job.job}, ${source})` : '');
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
  if (tries !== undefined && (!Number.isInteger(tries) || tries < 1)) throw new QueueSetupError(withCode('Q4', `${label}${where()}: static tries must be a whole number ≥ 1, not ${String(tries)}.`));
  if (timeout !== undefined && !(timeoutValue !== undefined && timeoutValue > 0)) throw new QueueSetupError(withCode('Q4', `${label}${where()}: static timeout must be seconds > 0 or a duration like { minutes: 2 }, not ${JSON.stringify(timeout)}.`));
  if (backoff !== undefined && backoffSeconds(backoff) === undefined) {
    throw new QueueSetupError(withCode('Q4', `${label}${where()}: static backoff must be seconds ≥ 0 — a number, a duration like { minutes: 1 }, or a list like [10, { minutes: 1 }, 300].`));
  }
  const { middleware } = job;
  if (middleware !== undefined && (!Array.isArray(middleware) || middleware.some((layer) => typeof (layer as { handle?: unknown } | null)?.handle !== 'function'))) {
    throw new QueueSetupError(withCode('Q4', `${label}${where()}: static middleware must be a list of job middleware — objects with handle(context, next), like withoutOverlapping(…).`));
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
