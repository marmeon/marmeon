import { setTimeout as delay } from 'node:timers/promises';
import type { Clock, Logger, Redactor } from '@marmeon/core';
import type { Scheduler, TaskRun } from './scheduler.ts';
import { MINUTE, minuteOf } from './time.ts';

/** Waits `ms` real milliseconds — or until `signal` aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const realSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined);

/**
 * The loop of `marmeon schedule:work`: a tick at the start of every minute, by the app's {@link Clock}. Runs started
 * by one tick do not hold up the next. A loop that wakes up late — the machine slept, the process was stopped — ticks
 * the minute it woke up in; what was missed meanwhile is caught up once by the tick (`catchUp('once')`).
 */
export class ScheduleWorker {
  readonly #scheduler: Scheduler;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #redactor: Redactor;
  readonly #running = new Set<Promise<unknown>>();

  /** `redactor` masks a failed tick's text in the log: the app's (`app.container.make(Redactor)`), so the names its packages add (the session cookie) count too. */
  constructor(scheduler: Scheduler, clock: Clock, logger: Logger, redactor: Redactor) {
    this.#scheduler = scheduler;
    this.#clock = clock;
    this.#logger = logger;
    this.#redactor = redactor;
  }

  /** Runs still going. */
  get running(): number {
    return this.#running.size;
  }

  /** Ticks until `signal` aborts; resolves then (without waiting for runs — see {@link drain}). */
  async run(options: { signal: AbortSignal; sleep?: Sleep; onTick?: (minute: number, runs: TaskRun[]) => void }): Promise<void> {
    const sleep = options.sleep ?? realSleep;
    let last = Number.NEGATIVE_INFINITY;
    while (!options.signal.aborted) {
      const now = this.#clock.now();
      await sleep(minuteOf(now) + MINUTE - now, options.signal);
      if (options.signal.aborted) break;
      const minute = minuteOf(this.#clock.now());
      // A timer that fired a little early: the same minute again — wait on.
      if (minute <= last) continue;
      last = minute;
      try {
        const runs = await this.#scheduler.tick(minute);
        for (const run of runs) {
          const done = run.done.finally(() => this.#running.delete(done));
          this.#running.add(done);
        }
        options.onTick?.(minute, runs);
      } catch (error) {
        // The cache is down, say: this minute is lost, the next one is tried again.
        this.#logger.error('The scheduler could not tick', { exception: this.#redactor.text(error instanceof Error ? `${error.name}: ${error.message}` : String(error)) });
      }
    }
  }

  /** Waits up to `seconds` for the runs still going; whether they all ended. */
  async drain(seconds: number): Promise<boolean> {
    if (this.#running.size === 0) return true;
    const ended = Promise.all(this.#running).then(() => true);
    return Promise.race([ended, delay(seconds * 1000, false, { ref: false })]);
  }
}
