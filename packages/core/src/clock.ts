import { token } from './token.ts';

/**
 * The time, injected: services that expire, schedule or wait take a `Clock` instead of calling `Date.now()`, so a
 * test can move time (`app.travel({ minutes: 5 })`, `app.freeze()`) without fake timers.
 *
 * ```ts
 * constructor(clock: Clock) { this.#clock = clock; }
 * const expires = this.#clock.now() + 60_000;
 * ```
 */
export interface Clock {
  /** Milliseconds since the epoch, like `Date.now()`. */
  now(): number;
}
export const Clock = token<Clock>('Clock');

/** The real time — the binding outside tests. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** A span of time, as for `Temporal.Duration`: `{ minutes: 5 }`, `{ hours: 1, seconds: 30 }`. */
export interface Duration {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly milliseconds?: number;
}

/** A duration in milliseconds. Negative parts go back in time. */
export function durationToMilliseconds(duration: Duration): number {
  const { days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = duration;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

/**
 * A clock tests move: it runs with the real time plus an offset, until {@link freeze} stops it. `@marmeon/testing`
 * binds one in every test app (`app.travel`, `app.freeze`).
 */
export class TestClock implements Clock {
  #offset = 0;
  #frozen: number | undefined;

  now(): number {
    return this.#frozen ?? Date.now() + this.#offset;
  }

  /** Moves the time forward (or back, with negative parts) — frozen or not. */
  travel(duration: Duration): number {
    const by = durationToMilliseconds(duration);
    if (this.#frozen === undefined) this.#offset += by;
    else this.#frozen += by;
    return this.now();
  }

  /** Jumps to a point in time (and keeps running from there unless frozen). */
  travelTo(time: Date | number): number {
    const target = typeof time === 'number' ? time : time.getTime();
    if (this.#frozen === undefined) this.#offset = target - Date.now();
    else this.#frozen = target;
    return this.now();
  }

  /** Stops the time where it is (or at `time`): `now()` returns the same value until the next travel. */
  freeze(time?: Date | number): number {
    this.#frozen = time === undefined ? this.now() : typeof time === 'number' ? time : time.getTime();
    return this.#frozen;
  }

  /** Lets the time run again, from where it stood. */
  unfreeze(): number {
    if (this.#frozen !== undefined) {
      this.#offset = this.#frozen - Date.now();
      this.#frozen = undefined;
    }
    return this.now();
  }
}
