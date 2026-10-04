import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

/** App-level settings. Packages bring their own (e.g. PORT → ServerConfig, LOG_LEVEL → LogConfig). */
export const AppConfig = defineConfig('app', {
  env: v.object({
    APP_NAME: v.pipe(v.string(), v.nonEmpty()),
    APP_URL: v.pipe(v.string(), v.url()),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
