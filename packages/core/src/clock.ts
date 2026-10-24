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

/** The parts of a span of time, as for `Temporal.Duration`: `{ minutes: 5 }`, `{ hours: 1, seconds: 30 }`. */
export interface DurationParts {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly milliseconds?: number;
}

/**
 * A span of time: a number is seconds, an object spells the parts out (`{ minutes: 60 }`). There are no strings (`'60m'`), and
 * no `years`, `months` or `weeks`, whose length depends on the calendar. See docs/time.md#spans-of-time.
 */
export type Duration = number | DurationParts;

const PARTS = ['days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const;
/** Parts whose length depends on the calendar (or is below a millisecond): refused unless zero, as a `Temporal.Duration` has them. */
const REFUSED_PARTS = ['years', 'months', 'weeks', 'microseconds', 'nanoseconds'] as const;
const UNIT_PART = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' } as const;

/** What the error says to write instead: `'60m'` → ``{ minutes: 60 }``. */
function hint(value: unknown): string {
  const match = typeof value === 'string' ? /^(\d+)([smhd])$/.exec(value) : null;
  return match ? `write \`{ ${UNIT_PART[match[2] as keyof typeof UNIT_PART]}: ${match[1]} }\`` : 'write seconds as a number or the parts as an object, like `{ minutes: 60 }`';
}

/** The milliseconds of a span, or a `TypeError` for anything that is not a {@link Duration}. */
function checked(duration: unknown): number {
  const invalid = (what: string) => new TypeError(`Not a span of time: ${what} — ${hint(duration)}.`);
  if (typeof duration === 'number') {
    if (!Number.isFinite(duration)) throw invalid(String(duration));
    return duration * 1000;
  }
  if (typeof duration !== 'object' || duration === null || Array.isArray(duration)) throw invalid(JSON.stringify(duration) ?? String(duration));
  // By property access, not `Object.keys`: a `Temporal.Duration` keeps its fields as getters on the prototype.
  const parts = duration as Record<string, unknown>;
  for (const key of Object.keys(parts)) {
    if (!(PARTS as readonly string[]).includes(key) && !(REFUSED_PARTS as readonly string[]).includes(key)) throw invalid(`"${key}" is not a part`);
  }
  for (const key of REFUSED_PARTS) {
    const value = parts[key];
    if (value !== undefined && value !== 0) throw invalid(`"${key}" is not a part`);
  }
  for (const key of PARTS) {
    const value = parts[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw invalid(`${key} is ${String(value)}`);
  }
  const { days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = parts as DurationParts;
  const total = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  if (!Number.isFinite(total)) throw invalid('it is too large');
  return total;
}

/** A span in milliseconds; a number is seconds. Negative parts go back in time. Throws a `TypeError` for a string or an unknown part. */
export function durationToMilliseconds(duration: Duration): number {
  return checked(duration);
}

/** A span in seconds, fractions kept — round it where it becomes an expiry (down, so a link never lives longer than asked). */
export function durationToSeconds(duration: Duration): number {
  return checked(duration) / 1000;
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

  /** Moves the time forward (or back, with negative parts; a number is seconds) — frozen or not. */
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
