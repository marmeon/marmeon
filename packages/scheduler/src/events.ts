import type { RunReason, SkipReason } from './scheduler.ts';

/**
 * What every scheduler event says about its run. They go through the
 * app's `EventDispatcher`: listen to one (`listen(ScheduledTaskFailed, AlertOnFailedTask)`) or to all of them
 * (`listen(ScheduledTaskEvent, …)`); tests see them in `app.events`.
 *
 * They are not queueable (no `static event` + `static schema`): their listeners run in the scheduler's process, where the
 * task runs. An error of a listener is logged and changes nothing about the run.
 */
export abstract class ScheduledTaskEvent {
  /** The task's name (unique in the app). */
  readonly task: string;
  /** The minute it was due (epoch ms) — for a catch-up, the last minute it was missed. */
  readonly minute: number;
  /** `due`, `catch-up` (missed while the scheduler was down) or `test` (`schedule:test`). */
  readonly reason: RunReason;

  constructor(data: { task: string; minute: number; reason: RunReason }) {
    this.task = data.task;
    this.minute = data.minute;
    this.reason = data.reason;
  }
}

/** The task passed its filters and locks and starts now. */
export class ScheduledTaskStarting extends ScheduledTaskEvent {
  readonly #event = true;
}

/** The task ran to its end. */
export class ScheduledTaskFinished extends ScheduledTaskEvent {
  readonly #event = true;
  /** How long it ran. */
  readonly ms: number;

  constructor(data: ConstructorParameters<typeof ScheduledTaskEvent>[0] & { ms: number }) {
    super(data);
    this.ms = data.ms;
  }
}

/** The task failed (it threw, or its command exited with an error) — the scheduler goes on. Once per failed run. */
export class ScheduledTaskFailed extends ScheduledTaskEvent {
  readonly #event = true;
  /** What it threw (a log or an alert should redact it — a message may quote a secret). */
  readonly error: unknown;
  readonly ms: number;

  constructor(data: ConstructorParameters<typeof ScheduledTaskEvent>[0] & { error: unknown; ms: number }) {
    super(data);
    this.error = data.error;
    this.ms = data.ms;
  }
}

/**
 * The task was due but did not run: `filter` (its `when()`/`skip()` said no), `other-server` (`onOneServer()`: another
 * scheduler took the minute), `overlapping` (`withoutOverlapping()`: its last run still runs), `job-waiting` (`s.job()`:
 * the job queued last time still waits — after `ScheduledTaskStarting`).
 */
export class ScheduledTaskSkipped extends ScheduledTaskEvent {
  readonly #event = true;
  readonly skipped: SkipReason;

  constructor(data: ConstructorParameters<typeof ScheduledTaskEvent>[0] & { skipped: SkipReason }) {
    super(data);
    this.skipped = data.skipped;
  }
}
