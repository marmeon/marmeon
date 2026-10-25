import { AsyncLocalStorage } from 'node:async_hooks';

/** What every log entry of a request carries. */
export interface CurrentRequest {
  readonly requestId: string;
}

/** What every log entry of a queued job carries — the job's name, its id (stable over retries) and the attempt. */
export interface CurrentJob {
  readonly job: string;
  readonly jobId: string;
  readonly attempt: number;
  /**
   * The request the job comes from — also through jobs it dispatched in between: a job dispatched here carries it on.
   * Not in the log context (a job's log entries name the job).
   */
  readonly requestId?: string;
  /**
   * The job was queued by an error reporter, or by a job that was: its failure is logged, never reported — a reporter that queues
   * an alert job would otherwise be told about the alert's failure, and queue another, without end. Not in the log context.
   */
  readonly fromReporter?: true;
}

// The one deliberate piece of ambient state: the unit of work being handled — a request or a job — for
// cross-cutting concerns like logging, so a logger needs nothing passed around. Context only, never services or data.
const requests = new AsyncLocalStorage<CurrentRequest>();
const jobs = new AsyncLocalStorage<CurrentJob>();
const tasks = new AsyncLocalStorage<CurrentTask>();

/** What every log entry of a scheduled task carries — its name (@marmeon/scheduler). */
export interface CurrentTask {
  readonly task: string;
}

/** Runs `fn` with `info` as the current request — set by the HTTP kernel per request. */
export function runWithRequest<T>(info: CurrentRequest, fn: () => T): T {
  return requests.run(info, fn);
}

/** The request currently being handled, if any. */
export function currentRequest(): CurrentRequest | undefined {
  return requests.getStore();
}

/** Runs `fn` with `info` as the current job — set by the queue worker per attempt. */
export function runWithJob<T>(info: CurrentJob, fn: () => T): T {
  return jobs.run(info, fn);
}

/** The job currently being handled, if any. */
export function currentJob(): CurrentJob | undefined {
  return jobs.getStore();
}

/** Runs `fn` with `info` as the current scheduled task — set by the scheduler per run. */
export function runWithTask<T>(info: CurrentTask, fn: () => T): T {
  return tasks.run(info, fn);
}

/** The scheduled task currently running, if any. */
export function currentTask(): CurrentTask | undefined {
  return tasks.getStore();
}

/**
 * What a log entry written now carries: `{ requestId }` in a request, `{ job, jobId, attempt }` in a job (both, when a job
 * runs inside a request), `{ task }` in a scheduled task.
 */
export function currentLogContext(): Readonly<Record<string, unknown>> {
  const request = requests.getStore();
  const job = jobs.getStore();
  const task = tasks.getStore();
  if (!request && !job && !task) return {};
  return {
    ...(request ? { requestId: request.requestId } : {}),
    ...(job ? { job: job.job, jobId: job.jobId, attempt: job.attempt } : {}),
    ...(task ? { task: task.task } : {}),
  };
}
