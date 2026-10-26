import { defineModule } from '@marmeon/core';
import { WebhooksConfig } from './config.ts';
import { WebhooksServiceProvider } from './WebhooksServiceProvider.ts';
import routes from './routes.ts';

/** An endpoint for a payment provider's events (`/webhooks/payments`): accepted only with the sender's signature. */
export default defineModule({
  name: 'webhooks',
  config: [WebhooksConfig],
  providers: [WebhooksServiceProvider],
  routes,
});
