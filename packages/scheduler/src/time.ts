import { CronExpression, ScheduleError, type WallTime } from './cron.ts';
import { withCode } from '@marmeon/core/internal';

export const MINUTE = 60_000;

/** The start of the minute `time` lies in (epoch milliseconds). */
export function minuteOf(time: number): number {
  return Math.floor(time / MINUTE) * MINUTE;
}

/** Fails for a time zone `Temporal` does not know: `Europe/Berln`. */
export function checkTimeZone(timeZone: string, where: string): string {
  try {
    return Temporal.Now.zonedDateTimeISO(timeZone).timeZoneId;
  } catch {
    throw new ScheduleError(withCode('Q5', `${where}: "${timeZone}" is not a time zone — use an IANA name like Europe/Berlin or UTC.`));
  }
}

function zoned(time: number, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone);
}

function wall(value: Temporal.ZonedDateTime | Temporal.PlainDateTime): WallTime {
  return { year: value.year, month: value.month, day: value.day, hour: value.hour, minute: value.minute, weekday: value.dayOfWeek % 7 };
}

/**
 * Whether a task with `expression` is due in the minute starting at `minute` (epoch ms), on the clocks of `timeZone` —
 * correct across daylight saving time:
 *
 * - **Clocks go forward** (Europe/Berlin, last Sunday of March, 02:00 → 03:00): local times in the gap never happen. A
 *   task due in the gap (`daily().at('02:30')`) runs in the first minute after it (03:00) — once, not never.
 * - **Clocks go back** (last Sunday of October, 03:00 → 02:00): the hour repeats. A task for particular hours
 *   (`at('02:30')`) runs in the first pass only; a task for every hour (`*` in the hour field, `everyMinute()`,
 *   `everyFiveMinutes()`, `hourly()`) runs in both, as the minutes really pass.
 */
export function isDue(expression: CronExpression, minute: number, timeZone: string): boolean {
  const now = zoned(minute, timeZone);
  if (expression.hourRestricted) {
    // The second pass of a repeated hour: this local time happened an hour ago already.
    const first = now.toPlainDateTime().toZonedDateTime(timeZone, { disambiguation: 'earlier' });
    if (first.epochMilliseconds !== now.epochMilliseconds) return false;
  }
  if (expression.matches(wall(now))) return true;
  // Right after the clocks went forward: the local minutes that were skipped count as now.
  const before = zoned(minute - MINUTE, timeZone).toPlainDateTime();
  const current = now.toPlainDateTime();
  if (Temporal.PlainDateTime.compare(before.add({ minutes: 1 }), current) >= 0) return false;
  for (let skipped = before.add({ minutes: 1 }); Temporal.PlainDateTime.compare(skipped, current) < 0; skipped = skipped.add({ minutes: 1 })) {
    if (expression.matches(wall(skipped))) return true;
  }
  return false;
}

/**
 * The minutes from `from` up to and including `to` (both minute starts) in which the task is due, first to last — walked
 * quickly: a local hour that cannot match is skipped (in steps that never jump over a clock change, which always
 * happens on a quarter hour of UTC).
 */
export function* dueMinutes(expression: CronExpression, from: number, to: number, timeZone: string): Generator<number> {
  let minute = minuteOf(from);
  while (minute <= to) {
    const now = zoned(minute, timeZone);
    // (Never right after a clock change: the minutes it skipped may be due now.)
    if (!expression.matchesHour(wall(now)) && zoned(minute - MINUTE, timeZone).offsetNanoseconds === now.offsetNanoseconds) {
      // Not this local hour: on to the next local hour or quarter hour of UTC, whichever comes first.
      const toNextHour = 60 - now.minute;
      const toNextQuarter = 15 - ((minute / MINUTE) % 15);
      minute += Math.min(toNextHour, toNextQuarter) * MINUTE;
      continue;
    }
    if (isDue(expression, minute, timeZone)) yield minute;
    minute += MINUTE;
  }
}

/** The next minute after `after` in which the task is due — looking ahead at most `days` days. */
export function nextDue(expression: CronExpression, after: number, timeZone: string, days = 400): number | undefined {
  for (const minute of dueMinutes(expression, minuteOf(after) + MINUTE, minuteOf(after) + days * 24 * 60 * MINUTE, timeZone)) return minute;
  return undefined;
}

/** The last minute from `from` up to and including `to` in which the task was due. */
export function lastDue(expression: CronExpression, from: number, to: number, timeZone: string): number | undefined {
  let last: number | undefined;
  for (const minute of dueMinutes(expression, from, to, timeZone)) last = minute;
  return last;
}

/** `2026-03-29 03:00 Europe/Berlin` — a minute for messages and `schedule:list`. */
export function formatMinute(minute: number, timeZone: string): string {
  const time = zoned(minute, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${time.year}-${pad(time.month)}-${pad(time.day)} ${pad(time.hour)}:${pad(time.minute)}`;
}
