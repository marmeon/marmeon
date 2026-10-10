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

  /** Registers job classes; `source` names where they come from in errors (`module auth`). */
  add(jobs: readonly JobClass[], source: string, options: { framework?: boolean } = {}): this {
    for (const job of jobs) {
      const name = checkJobClass(job, source);
      if (name.startsWith(FRAMEWORK_PREFIX) && !options.framework) {
        throw new QueueSetupError(`${job.name} (${source}) is named "${name}" — names under "${FRAMEWORK_PREFIX}" belong to the framework. Choose another static job.`);
      }
      const existing = this.#jobs.get(name);
      if (existing && existing.job !== job) {
        throw new QueueSetupError(
          `Two jobs are named "${name}": ${existing.job.name} (${existing.source}) and ${job.name} (${source}). A job's name is how the queue finds its class — give each its own static job.`,
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
  if (typeof job !== 'function') throw new QueueSetupError(`${source} lists ${label} as a job, but it is not a class.`);
  if (typeof job.job !== 'string' || !NAME.test(job.job)) {
    throw new QueueSetupError(
      `${label} (${source}) needs a stable name: static job = 'module.what-it-does' (lower case; letters, digits and . - _ : between parts) — never the class name, which changes with refactoring.` +
        (typeof job.job === 'string' ? ` "${job.job}" is not one.` : ''),
    );
  }
  if (typeof job.schema?.['~standard']?.validate !== 'function') {
    throw new QueueSetupError(`${label} (${job.job}, ${source}) needs static schema — a Standard Schema of its payload, e.g. v.object({ userId: v.number() }).`);
  }
  if (typeof job.prototype?.handle !== 'function') throw new QueueSetupError(`${label} (${job.job}, ${source}) needs a handle(payload, job) method.`);
  const { tries, timeout, backoff } = job;
  if (tries !== undefined && (!Number.isInteger(tries) || tries < 1)) throw new QueueSetupError(`${label}: static tries must be a whole number ≥ 1, not ${String(tries)}.`);
  if (timeout !== undefined && !(typeof timeout === 'number' && timeout > 0)) throw new QueueSetupError(`${label}: static timeout must be seconds > 0, not ${String(timeout)}.`);
  const delays = backoff === undefined ? [] : typeof backoff === 'number' ? [backoff] : backoff;
  if (!Array.isArray(delays) || delays.some((delay) => !(typeof delay === 'number' && delay >= 0))) {
    throw new QueueSetupError(`${label}: static backoff must be seconds ≥ 0 — a number or a list like [10, 60, 300].`);
  }
  const { middleware } = job;
  if (middleware !== undefined && (!Array.isArray(middleware) || middleware.some((layer) => typeof (layer as { handle?: unknown } | null)?.handle !== 'function'))) {
    throw new QueueSetupError(`${label}: static middleware must be a list of job middleware — objects with handle(context, next), like withoutOverlapping(…).`);
  }
  return job.job;
}

/** Defaults of a job class's retry settings. */
export const DEFAULT_TIMEOUT = 60;

export function triesOf(job: JobClass): number {
  return job.tries ?? 1;
}

export function backoffOf(job: JobClass): number[] {
  return job.backoff === undefined ? [] : typeof job.backoff === 'number' ? [job.backoff] : [...job.backoff];
}

export function timeoutOf(job: JobClass): number {
  return job.timeout ?? DEFAULT_TIMEOUT;
}
