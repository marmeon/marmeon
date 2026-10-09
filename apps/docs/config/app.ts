import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** App-level settings. Packages bring their own (PORT → ServerConfig, LOG_LEVEL → LogConfig). */
export const AppConfig = defineConfig('app', {
  env: env({
    APP_NAME: env.string().default('Marmeon docs'),
    APP_URL: env.url().default('http://localhost:3970'),
  }),
  resolve: (e) => ({ name: e.APP_NAME, url: e.APP_URL }),
});
export type AppConfig = ConfigOf<typeof AppConfig>;
