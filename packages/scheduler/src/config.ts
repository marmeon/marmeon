import { defineConfig, environment, type ConfigOf } from '@bespokecore/core';
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
 * `environments('production')` compares against `NODE_ENV` — a missing one counts as `production` (E139: an unset `NODE_ENV` is
 * protected like production; Laravel's `APP_ENV` defaults to `production` too).
 */
export const ScheduleConfig = defineConfig('schedule', {
  env: v.object({
    SCHEDULE_TIMEZONE: v.optional(v.pipe(v.string(), v.check(isTimeZone, 'Expected an IANA time zone like Europe/Berlin or UTC')), 'UTC'),
    NODE_ENV: v.optional(v.string()),
  }),
  resolve: (env) => ({ timezone: env.SCHEDULE_TIMEZONE, environment: environment.name(env) ?? 'production' }),
});
export type ScheduleConfig = ConfigOf<typeof ScheduleConfig>;
