import { describe, expect, it } from 'vitest';
import { CronExpression, ScheduleError } from './cron.ts';
import { dueMinutes, isDue, lastDue, MINUTE, nextDue } from './time.ts';

const at = (iso: string) => Temporal.ZonedDateTime.from(iso).epochMilliseconds;
const utc = (iso: string) => Date.parse(iso);
const day = (date: string, timeZone: string) => {
  const start = Temporal.PlainDate.from(date).toZonedDateTime(timeZone).epochMilliseconds;
  const end = Temporal.PlainDate.from(date).add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds - MINUTE;
  return [start, end] as const;
};
/** Every minute of the day, one by one — no skipping — and when the task is due. */
const everyMinuteOf = (expression: string, date: string, timeZone: string) => {
  const cron = new CronExpression(expression);
  const [start, end] = day(date, timeZone);
  const due: string[] = [];
  for (let minute = start; minute <= end; minute += MINUTE) {
    if (isDue(cron, minute, timeZone)) due.push(Temporal.Instant.fromEpochMilliseconds(minute).toZonedDateTimeISO(timeZone).toString({ smallestUnit: 'minute' }));
  }
  return due;
};

describe('cron expressions', () => {
  const wall = (minute: number, hour: number, day: number, month: number, weekday: number) => ({ year: 2026, minute, hour, day, month, weekday });

  it('read *, values, ranges, lists, steps and names', () => {
    const cron = new CronExpression('*/15 9-17 * jan,jul mon-fri');
    expect(cron.matches(wall(30, 9, 5, 1, 1))).toBe(true);
    expect(cron.matches(wall(31, 9, 5, 1, 1))).toBe(false);
    expect(cron.matches(wall(30, 18, 5, 1, 1))).toBe(false);
    expect(cron.matches(wall(30, 9, 5, 2, 1))).toBe(false);
    expect(cron.matches(wall(30, 9, 5, 7, 0))).toBe(false);
    expect(new CronExpression('5/20 * * * *').matches(wall(45, 0, 1, 1, 0))).toBe(true);
    expect(new CronExpression('0 0 * * 7').matches(wall(0, 0, 1, 1, 0))).toBe(true); // 7 = Sunday
    expect(new CronExpression('@daily').source).toBe('@daily');
    expect(new CronExpression('@daily').matches(wall(0, 0, 9, 9, 3))).toBe(true);
  });

  it('match day of month OR day of week when both are restricted, like every cron', () => {
    const cron = new CronExpression('0 0 1 * mon');
    expect(cron.matches(wall(0, 0, 1, 3, 4))).toBe(true); // the 1st, a Thursday
    expect(cron.matches(wall(0, 0, 9, 3, 1))).toBe(true); // a Monday
    expect(cron.matches(wall(0, 0, 9, 3, 2))).toBe(false);
    expect(new CronExpression('0 0 1 * *').matches(wall(0, 0, 9, 3, 1))).toBe(false);
  });

  it('say what is wrong with an invalid expression', () => {
    expect(() => new CronExpression('* * * *')).toThrow(/needs five fields/);
    expect(() => new CronExpression('61 * * * *')).toThrow('the minute field "61" has 61, outside 0–59');
    expect(() => new CronExpression('* 25 * * *')).toThrow(/hour field "25" has 25, outside 0–23/);
    expect(() => new CronExpression('*/0 * * * *')).toThrow(/invalid step "0"/);
    expect(() => new CronExpression('* * * foo *')).toThrow(/neither a number nor a name/);
    expect(() => new CronExpression('5-1 * * * *')).toThrow(/runs backwards/);
    expect(() => new CronExpression('* * * * *')).not.toThrow(ScheduleError);
  });
});

describe('due times across daylight saving time (Europe/Berlin)', () => {
  const berlin = 'Europe/Berlin';

  it('runs daily().at("02:30") exactly once on the day the clocks go forward (29 March) — right after the gap', () => {
    expect(everyMinuteOf('30 2 * * *', '2026-03-29', berlin)).toEqual(['2026-03-29T03:00+02:00[Europe/Berlin]']);
    // The days around it: at 02:30, as always.
    expect(everyMinuteOf('30 2 * * *', '2026-03-28', berlin)).toEqual(['2026-03-28T02:30+01:00[Europe/Berlin]']);
    expect(everyMinuteOf('30 2 * * *', '2026-03-30', berlin)).toEqual(['2026-03-30T02:30+02:00[Europe/Berlin]']);
  });

  it('runs daily().at("02:30") exactly once on the day the clocks go back (25 October) — in the first pass of the hour', () => {
    expect(everyMinuteOf('30 2 * * *', '2026-10-25', berlin)).toEqual(['2026-10-25T02:30+02:00[Europe/Berlin]']);
  });

  it('runs tasks for every hour as the minutes really pass: 23 hours in March, 25 in October', () => {
    expect(everyMinuteOf('0 * * * *', '2026-03-29', berlin)).toHaveLength(23);
    expect(everyMinuteOf('0 * * * *', '2026-10-25', berlin)).toHaveLength(25);
    expect(everyMinuteOf('* * * * *', '2026-03-29', berlin)).toHaveLength(23 * 60);
    expect(everyMinuteOf('* * * * *', '2026-10-25', berlin)).toHaveLength(25 * 60);
    // A time that exists once is untouched: 03:10 on both days.
    expect(everyMinuteOf('10 3 * * *', '2026-03-29', berlin)).toEqual(['2026-03-29T03:10+02:00[Europe/Berlin]']);
    expect(everyMinuteOf('10 3 * * *', '2026-10-25', berlin)).toEqual(['2026-10-25T03:10+01:00[Europe/Berlin]']);
  });

  it('runs at the same UTC minutes in UTC, whatever Berlin does', () => {
    expect(everyMinuteOf('30 2 * * *', '2026-03-29', 'UTC')).toEqual(['2026-03-29T02:30+00:00[UTC]']);
  });

  it('finds the due minutes quickly, the same ones as minute by minute', () => {
    for (const expression of ['30 2 * * *', '0 * * * *', '*/7 1-4 * * *', '0 0 29 2 *', '15 3 * * sun']) {
      const cron = new CronExpression(expression);
      for (const date of ['2026-03-29', '2026-10-25']) {
        const [start, end] = day(date, berlin);
        const slow: number[] = [];
        for (let minute = start; minute <= end; minute += MINUTE) if (isDue(cron, minute, berlin)) slow.push(minute);
        expect([...dueMinutes(cron, start, end, berlin)]).toEqual(slow);
      }
    }
  });

  it('tells the next and the last due minute', () => {
    const cron = new CronExpression('30 2 * * *');
    expect(nextDue(cron, at('2026-03-28T12:00+01:00[Europe/Berlin]'), berlin)).toBe(at('2026-03-29T03:00+02:00[Europe/Berlin]'));
    expect(nextDue(new CronExpression('0 0 29 2 *'), utc('2026-03-01T00:00Z'), 'UTC', 1500)).toBe(utc('2028-02-29T00:00Z'));
    expect(lastDue(cron, at('2026-03-27T00:00+01:00[Europe/Berlin]'), at('2026-03-29T12:00+02:00[Europe/Berlin]'), berlin)).toBe(at('2026-03-29T03:00+02:00[Europe/Berlin]'));
    expect(lastDue(cron, at('2026-03-29T04:00+02:00[Europe/Berlin]'), at('2026-03-29T12:00+02:00[Europe/Berlin]'), berlin)).toBeUndefined();
  });
});
