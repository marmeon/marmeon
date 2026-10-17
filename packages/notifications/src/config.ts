import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** Notifications: `NOTIFICATIONS_CONNECTION` (default `default`), the database connection of the `marmeon_notifications` table. */
export const NotificationConfig = defineConfig('notifications', {
  env: env({
    NOTIFICATIONS_CONNECTION: env.string().default('default'),
  }),
  resolve: (e) => ({ connection: e.NOTIFICATIONS_CONNECTION }),
});
export type NotificationConfig = ConfigOf<typeof NotificationConfig>;
