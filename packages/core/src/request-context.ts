import { AsyncLocalStorage } from 'node:async_hooks';

/** What every log entry of a request carries. */
export interface RequestInfo {
  readonly requestId: string;
}

/** What every log entry of a queued job carries — the job's name, its id (stable over retries) and the attempt. */
export interface JobInfo {
  readonly job: string;
  readonly jobId: string;
  readonly attempt: number;
}

// The one deliberate piece of ambient state (decision E3): the unit of work being handled — a request or a job — for
// cross-cutting concerns like logging, so a logger needs nothing passed around. Context only, never services or data.
const requests = new AsyncLocalStorage<RequestInfo>();
const jobs = new AsyncLocalStorage<JobInfo>();

/** Runs `fn` with `info` as the current request — set by the HTTP kernel per request. */
export function runWithRequest<T>(info: RequestInfo, fn: () => T): T {
  return requests.run(info, fn);
}

/** The request currently being handled, if any. */
export function currentRequest(): RequestInfo | undefined {
  return requests.getStore();
}

/** Runs `fn` with `info` as the current job — set by the queue worker per attempt. */
export function runWithJob<T>(info: JobInfo, fn: () => T): T {
  return jobs.run(info, fn);
}

/** The job currently being handled, if any. */
export function currentJob(): JobInfo | undefined {
  return jobs.getStore();
}

/** What a log entry written now carries: `{ requestId }` in a request, `{ job, jobId, attempt }` in a job (both, when a job runs inside a request). */
export function currentLogContext(): Readonly<Record<string, unknown>> {
  const request = requests.getStore();
  const job = jobs.getStore();
  if (!request && !job) return {};
  return { ...(request ? { requestId: request.requestId } : {}), ...(job ? { job: job.job, jobId: job.jobId, attempt: job.attempt } : {}) };
}
