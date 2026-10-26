import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application, ServiceProvider } from '@marmeon/core';
import { Webhooks } from '@marmeon/http';
import { PaymentsConfig } from './config.ts';

export class PaymentsServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // The sender's name is what the route says in `verifyWebhook('payments')`. The secret comes from the environment, never from the route file.
    app.container.make(Webhooks).define('payments', { scheme: 'stripe', secrets: app.container.make(PaymentsConfig).webhookSecret });
    // Forged requests count too, so a client that guesses signatures is slowed down; a real sender sends far fewer. Size the limit to the provider's peak: it sends from few addresses.
    app.container.make(RateLimiter).for('webhooks.payments', (ctx) => Limit.perMinute(120).by(clientKey(ctx.ip)));
  }
}
