import { describe, expect, it } from 'vitest';
import { Clock, durationToMilliseconds, SystemClock, TestClock } from './clock.ts';
import { createApplication } from './application.ts';

describe('Clock', () => {
  it('is the system clock unless something else is bound', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: {} });
    const clock = app.container.make(Clock);
    expect(clock).toBeInstanceOf(SystemClock);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
  });

  it('reads durations like Temporal.Duration', () => {
    expect(durationToMilliseconds({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 })).toBe(((26 * 60 + 3) * 60 + 4) * 1000 + 5);
    expect(durationToMilliseconds({ minutes: -1 })).toBe(-60_000);
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
