import { defineConfig, type ConfigOf } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/** App-level settings. Packages bring their own (PORT → ServerConfig, LOG_LEVEL → LogConfig). */
export const AppConfig = defineConfig('app', {
  env: r.env({
    APP_NAME: r.string().default('Marmeon docs'),
    APP_URL: r.url().default('http://localhost:3970'),
  }),
  resolve: (env) => ({ name: env.APP_NAME, url: env.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
