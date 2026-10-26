/**
 * Test doubles for apps' tests — see `docs/fakes.md#the-schedule`. `createTestApp()` creates the `ScheduleTester` as
 * `app.schedule`, so an app imports it only to type a variable.
 */
import type { Scheduler, TaskResult } from './scheduler.ts';
import { minuteOf } from './time.ts';

/** A point in time for `app.schedule`: a `Date`, epoch ms, an ISO string (`'2026-10-04T03:10:00+02:00'`, `'2026-03-29T03:00[Europe/Berlin]'`) or a Temporal instant. */
export type ScheduleTime = Date | number | string | Temporal.Instant | Temporal.ZonedDateTime;

/** Epoch milliseconds of a {@link ScheduleTime}. */
function toEpoch(time: ScheduleTime): number {
  if (typeof time === 'number') return time;
  if (time instanceof Date) return time.getTime();
  if (typeof time === 'string') {
    if (time.includes('[')) return Temporal.ZonedDateTime.from(time).epochMilliseconds;
    const parsed = Date.parse(time);
    if (Number.isNaN(parsed)) throw new TypeError(`"${time}" is not a point in time — use an ISO string like 2026-10-04T03:10:00+02:00.`);
    return parsed;
  }
  return time.epochMilliseconds;
}

/**
 * The schedule in tests (`app.schedule`, with the test app's clock):
 *
 * ```ts
 * expect(app.schedule.due('2026-10-04T03:10:00+02:00')).toContain('auth:prune-tokens');
 * const results = await app.schedule.run('2026-10-04T03:10:00+02:00');   // moves the clock there, ticks, waits for the runs
 * ```
 */
export class ScheduleTester {
  readonly #scheduler: Scheduler;
  readonly #travelTo: (time: number) => unknown;
  readonly #now: () => number;

  /** @internal `createTestApp()` makes it. */
  constructor(scheduler: Scheduler, clock: { travelTo(time: number): unknown; now(): number }) {
    this.#scheduler = scheduler;
    this.#travelTo = (time) => clock.travelTo(time);
    this.#now = () => clock.now();
  }

  /** The names of every task. */
  get tasks(): string[] {
    return this.#scheduler.tasks.map((task) => task.name);
  }

  /** The names of the tasks due in the minute of `time` (default: now) — by frequency and environment; filters are asked when they run. */
  due(time?: ScheduleTime): string[] {
    return this.#scheduler.due(time === undefined ? this.#now() : toEpoch(time)).map((task) => task.name);
  }

  /**
   * One tick, as `schedule:work` does it: moves the app's clock to `time` (if given), runs what is due — and what was
   * missed since the last tick (`catchUp('once')`) — and waits for the runs. Ticks of a test remember each other, like
   * a scheduler's: `run('10:00')`, then `run('10:10')` catches up 10:01–10:09 once.
   */
  async run(time?: ScheduleTime): Promise<TaskResult[]> {
    if (time !== undefined) this.#travelTo(toEpoch(time));
    const runs = await this.#scheduler.tick(minuteOf(this.#now()));
    return Promise.all(runs.map((run) => run.done));
  }

  /** Runs one task now, like `marmeon schedule:test <name>`. */
  async runTask(name: string): Promise<TaskResult> {
    return this.#scheduler.runNow(this.#scheduler.task(name)).done;
  }
}
