import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

function isTimeZone(value: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The scheduler (E88):
 *
 * ```sh
 * SCHEDULE_TIMEZONE=Europe/Berlin   # whose clocks the tasks' times are on, unless a task says .timezone(…) — default UTC
 * ```
 *
 * `environments('production')` compares against `NODE_ENV` (default `development`).
 */
export const ScheduleConfig = defineConfig('schedule', {
  env: v.object({
    SCHEDULE_TIMEZONE: v.optional(v.pipe(v.string(), v.check(isTimeZone, 'Expected an IANA time zone like Europe/Berlin or UTC')), 'UTC'),
    NODE_ENV: v.optional(v.string(), 'development'),
  }),
  resolve: (env) => ({ timezone: env.SCHEDULE_TIMEZONE, environment: env.NODE_ENV }),
});
export type ScheduleConfig = ConfigOf<typeof ScheduleConfig>;
