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
  /**
   * The request the job comes from — also through jobs it dispatched in between: a job dispatched here carries it on.
   * Not in the log context (a job's log entries name the job).
   */
  readonly requestId?: string;
}

// The one deliberate piece of ambient state: the unit of work being handled — a request or a job — for
// cross-cutting concerns like logging, so a logger needs nothing passed around. Context only, never services or data.
const requests = new AsyncLocalStorage<RequestInfo>();
const jobs = new AsyncLocalStorage<JobInfo>();
const tasks = new AsyncLocalStorage<TaskInfo>();

/** What every log entry of a scheduled task carries — its name (@marmeon/scheduler). */
export interface TaskInfo {
  readonly task: string;
}

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

/** Runs `fn` with `info` as the current scheduled task — set by the scheduler per run. */
export function runWithTask<T>(info: TaskInfo, fn: () => T): T {
  return tasks.run(info, fn);
}

/** The scheduled task currently running, if any. */
export function currentTask(): TaskInfo | undefined {
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
