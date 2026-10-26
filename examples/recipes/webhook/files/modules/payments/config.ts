import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** The secret a payment provider signs its requests with — shown in the provider's dashboard, kept in the environment. */
export const PaymentsConfig = defineConfig('payments', {
  env: env({
    PAYMENTS_WEBHOOK_SECRET: env.string().required("Missing — copy the signing secret of the endpoint from the provider's dashboard"),
  }),
  resolve: (e) => ({ webhookSecret: e.PAYMENTS_WEBHOOK_SECRET }),
});
export type PaymentsConfig = ConfigOf<typeof PaymentsConfig>;
