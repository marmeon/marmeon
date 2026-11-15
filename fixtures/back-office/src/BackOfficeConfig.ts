import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** Settings of the back office. */
export const BackOfficeConfig = defineConfig('backOffice', {
  env: env({
    /** Whose users the back office serves: its own editors (`own`, with a table, sign-in and sudo mode of its own), or the app's users (`app`, judged by the app's `OfficeAccess`). */
    BACK_OFFICE_USERS: env.in(['own', 'app']).default('own'),
    /** Where the back office lives: its pages are below this path. */
    BACK_OFFICE_PATH: env.string().regex(/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected one path segment like /office').default('/office'),
  }),
  resolve: (e) => ({ users: e.BACK_OFFICE_USERS, path: e.BACK_OFFICE_PATH }),
});
export type BackOfficeConfig = ConfigOf<typeof BackOfficeConfig>;
