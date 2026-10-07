import { defineConfig, type ConfigOf } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/** App-level settings. Packages bring their own (e.g. PORT → ServerConfig, LOG_LEVEL → LogConfig). */
export const AppConfig = defineConfig('app', {
  env: r.env({
    APP_NAME: r.string().required(),
    APP_URL: r.url(),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
