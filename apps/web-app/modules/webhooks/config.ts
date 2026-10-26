import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** The secret a payment provider signs its requests with — shown in the provider's dashboard, kept in the environment. */
export const WebhooksConfig = defineConfig('webhooks', {
  env: env({
    PAYMENTS_WEBHOOK_SECRET: env.string(),
  }),
  resolve: (e) => ({ paymentsSecret: e.PAYMENTS_WEBHOOK_SECRET }),
});
export type WebhooksConfig = ConfigOf<typeof WebhooksConfig>;
