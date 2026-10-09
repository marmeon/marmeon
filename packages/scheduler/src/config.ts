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
 * `environments('production')` compares against the app's environment name, `APP_ENV` (E221) — without one the name that goes with
 * `NODE_ENV`: `local` (development), `testing` (test), `production` (production or none). So a staging server
 * (`NODE_ENV=production APP_ENV=staging`) runs `.environments('staging')` and leaves `.environments('production')` out. `APP_ENV`
 * selects tasks only: it never weakens a protection or enables a development tool.
 */
export const ScheduleConfig = defineConfig('schedule', {
  env: env({
    SCHEDULE_TIMEZONE: env.string().check(isTimeZone, 'Expected an IANA time zone like Europe/Berlin or UTC').default('UTC'),
    NODE_ENV: env.string().optional(),
    APP_ENV: env.string().optional(),
  }),
  resolve: (e) => ({ timezone: e.SCHEDULE_TIMEZONE, environment: environment.app(e) }),
});
export type ScheduleConfig = ConfigOf<typeof ScheduleConfig>;
