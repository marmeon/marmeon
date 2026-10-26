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
 * The scheduler: `SCHEDULE_TIMEZONE` (default UTC) and the environment name `environments()` compares against — `APP_ENV`,
 * else the name that goes with `NODE_ENV`. `APP_ENV` selects tasks only: it never weakens a protection or enables a
 * development tool. See `docs/scheduling.md#conditions`.
 */
export const ScheduleConfig = defineConfig('schedule', {
  env: env({
    SCHEDULE_TIMEZONE: env.string().check(isTimeZone, 'Expected an IANA time zone like Europe/Berlin or UTC').default('UTC'),
    NODE_ENV: env.string().optional(),
    APP_ENV: env.string().optional(),
  }),
  resolve: (e) => ({ timeZone: e.SCHEDULE_TIMEZONE, environment: environment.app(e) }),
});
export type ScheduleConfig = ConfigOf<typeof ScheduleConfig>;
