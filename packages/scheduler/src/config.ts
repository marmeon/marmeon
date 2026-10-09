import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

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
  env: env({
    SCHEDULE_TIMEZONE: env.string().check(isTimeZone, 'Expected an IANA time zone like Europe/Berlin or UTC').default('UTC'),
    NODE_ENV: env.string().optional(),
  }),
  resolve: (e) => ({ timezone: e.SCHEDULE_TIMEZONE, environment: environment.name(e) ?? 'production' }),
});
export type ScheduleConfig = ConfigOf<typeof ScheduleConfig>;
