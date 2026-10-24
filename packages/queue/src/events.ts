/**
 * What every job event says about its job. The events go through the app's `EventDispatcher` — listen to one
 * (`listen(JobFailed, AlertOnFailedJob)`) or to all of them (`listen(JobEvent, …)`): the hook for observability.
 *
 * They are not queueable (no `static event` + `static schema`): a queued listener of a job event would queue a job,
 * whose events would queue the next — listeners run where the event happens (the worker, the dispatching process). An
 * error of a listener is logged and does not change what happens to the job.
 */
export abstract class JobEvent {
  /** The queue connection (`database`, `redis`, `sync` — `fake` in a test's `app.queue.work()`). */
  readonly connection: string;
  readonly queue: string;
  /** The job's stable name, `static job`. */
  readonly job: string;
  /** The job's id — stable over retries. */
  readonly jobId: string;

  constructor(data: { connection: string; queue: string; job: string; jobId: string }) {
    this.connection = data.connection;
    this.queue = data.queue;
    this.job = data.job;
    this.jobId = data.jobId;
  }
}

/** A job was queued — after the commit, when it was dispatched inside a transaction; also the next job of a chain. */
export class JobQueued extends JobEvent {
  readonly #event = true;
  /** Seconds before it may run. */
  readonly delaySeconds: number;

  constructor(data: ConstructorParameters<typeof JobEvent>[0] & { delaySeconds: number }) {
    super(data);
    this.delaySeconds = data.delaySeconds;
  }
}

/** A worker starts an attempt. */
export class JobProcessing extends JobEvent {
  readonly #event = true;
  /** The attempt, from 1. */
  readonly attempt: number;

  constructor(data: ConstructorParameters<typeof JobEvent>[0] & { attempt: number }) {
    super(data);
    this.attempt = data.attempt;
  }
}

/** An attempt succeeded: the job left the queue (also when it discarded itself). */
export class JobProcessed extends JobEvent {
  readonly #event = true;
  readonly attempt: number;
  /** How long the attempt took. */
  readonly ms: number;
  /** The job ended itself with `job.discard()`. */
  readonly discarded: boolean;

  constructor(data: ConstructorParameters<typeof JobEvent>[0] & { attempt: number; ms: number; discarded: boolean }) {
    super(data);
    this.attempt = data.attempt;
    this.ms = data.ms;
    this.discarded = data.discarded;
  }
}

/** An attempt ended and the job went back to the queue, to run again in `delaySeconds`. */
export class JobReleased extends JobEvent {
  readonly #event = true;
  readonly attempt: number;
  readonly delaySeconds: number;
  /**
   * `error`: the attempt failed and the job retries; `job`: the job (or a middleware) asked for it; `unknown`: no class for this name
   * here; `stopping`: the worker stops; `busy`: `job.once` found its key running in another attempt — this attempt is given back.
   */
  readonly reason: 'error' | 'job' | 'unknown' | 'stopping' | 'busy';
  readonly ms: number | undefined;

  constructor(data: ConstructorParameters<typeof JobEvent>[0] & { attempt: number; delaySeconds: number; reason: JobReleased['reason']; ms?: number }) {
    super(data);
    this.attempt = data.attempt;
    this.delaySeconds = data.delaySeconds;
    this.reason = data.reason;
    this.ms = data.ms;
  }
}

/** The job failed for good: it is in the failed jobs now (the rest of its chain is dropped). */
export class JobFailed extends JobEvent {
  readonly #event = true;
  readonly attempt: number;
  /** Why — as thrown (stored redacted in the failed jobs; a listener that logs it should redact it too). */
  readonly error: Error;

  constructor(data: ConstructorParameters<typeof JobEvent>[0] & { attempt: number; error: Error }) {
    super(data);
    this.attempt = data.attempt;
    this.error = data.error;
  }
}

/** Dispatches a job event. Built by the queue's provider from the app's `EventDispatcher`. */
export type JobEvents = (event: JobEvent) => Promise<void>;
