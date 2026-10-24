import { describe, expect, it } from 'vitest';
import { Clock, durationToMilliseconds, durationToSeconds, SystemClock, TestClock } from './clock.ts';
import { createApplication } from './application.ts';

describe('Clock', () => {
  it('is the system clock unless something else is bound', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const clock = app.container.make(Clock);
    expect(clock).toBeInstanceOf(SystemClock);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
  });

  it('reads durations like Temporal.Duration', () => {
    expect(durationToMilliseconds({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 })).toBe(((26 * 60 + 3) * 60 + 4) * 1000 + 5);
    expect(durationToMilliseconds({ minutes: -1 })).toBe(-60_000);
  });

  it('reads a number as seconds', () => {
    expect(durationToMilliseconds(90)).toBe(90_000);
    expect(durationToSeconds(90)).toBe(90);
    expect(durationToSeconds({ minutes: 1, milliseconds: 500 })).toBe(60.5);
    expect(durationToSeconds({ minutes: 60 })).toBe(durationToSeconds(3600));
  });

  it('refuses what is no span of time, saying what to write', () => {
    const refused = (value: unknown) => () => durationToSeconds(value as never);
    expect(refused('15m')).toThrow(TypeError);
    expect(refused('15m')).toThrow('write `{ minutes: 15 }`');
    expect(refused('7d')).toThrow('write `{ days: 7 }`');
    expect(refused('soon')).toThrow('write seconds as a number');
    // What a Temporal.Duration with calendar parts carries: their length depends on the calendar.
    expect(refused({ years: 1 })).toThrow('"years" is not a part');
    expect(refused({ weeks: 2, days: 1 })).toThrow('"weeks" is not a part');
    expect(refused({ minute: 5 })).toThrow('"minute" is not a part');
    expect(refused({ days: 1e305 })).toThrow('too large');
    expect(refused(Number.NaN)).toThrow(TypeError);
    expect(refused(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(refused({ minutes: Number.NaN })).toThrow('minutes is NaN');
    expect(refused({ minutes: '5' })).toThrow(TypeError);
    expect(refused(null)).toThrow(TypeError);
    expect(refused([5])).toThrow(TypeError);
  });
});

describe('TestClock', () => {
  it('runs with the real time, moved by travel()', () => {
    const clock = new TestClock();
    const before = Date.now();
    clock.travel({ hours: 1 });
    expect(clock.now()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(clock.now()).toBeLessThan(Date.now() + 3_600_000 + 50);
  });

  it('refuses a Temporal.Duration with calendar parts, which keeps its fields on the prototype', () => {
    const refused = (value: unknown) => () => durationToSeconds(value as never);
    for (const part of ['years', 'months', 'weeks', 'microseconds', 'nanoseconds']) {
      expect(refused(Temporal.Duration.from({ [part]: 1 })), part).toThrow(`"${part}" is not a part`);
    }
    expect(durationToSeconds(Temporal.Duration.from({ hours: 1, minutes: 30 }) as never)).toBe(5400);
    expect(durationToMilliseconds(Temporal.Duration.from({ days: 1, milliseconds: 5 }) as never)).toBe(86_400_005);
  });

  it('travels by seconds as a number, and back by a negative part', () => {
    const clock = new TestClock();
    const frozen = clock.freeze();
    expect(clock.travel(30)).toBe(frozen + 30_000);
    expect(clock.travel({ minutes: -1 })).toBe(frozen - 30_000);
    expect(() => clock.travel('1m' as never)).toThrow(TypeError);
    expect(clock.now()).toBe(frozen - 30_000);
  });

  it('stands still when frozen, until it travels or runs again', async () => {
    const clock = new TestClock();
    const frozen = clock.freeze();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clock.now()).toBe(frozen);
    expect(clock.travel({ seconds: 61 })).toBe(frozen + 61_000);
    clock.unfreeze();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clock.now()).toBeGreaterThan(frozen + 61_000);
  });

  it('jumps to a point in time', () => {
    const clock = new TestClock();
    clock.freeze(new Date('2026-12-24T18:00:00Z'));
    expect(new Date(clock.now()).toISOString()).toBe('2026-12-24T18:00:00.000Z');
    clock.travelTo(Date.UTC(2027, 0, 1));
    expect(new Date(clock.now()).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
