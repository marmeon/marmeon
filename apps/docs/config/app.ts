import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

/** App-level settings. Packages bring their own (PORT → ServerConfig, LOG_LEVEL → LogConfig). */
export const AppConfig = defineConfig('app', {
  env: v.object({
    APP_NAME: v.optional(v.pipe(v.string(), v.nonEmpty()), 'BespokeCore docs'),
    APP_URL: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:3970'),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
