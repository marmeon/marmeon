import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

/** Environment variables are always strings — numbers are converted explicitly. */
export const AppConfig = defineConfig('app', {
  env: v.object({
    APP_NAME: v.pipe(v.string(), v.nonEmpty()),
    APP_URL: v.pipe(v.string(), v.url()),
    PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)), '3000'),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL, port: env.PORT }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
