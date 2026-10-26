import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import type { Application } from '@marmeon/core';
import { Webhooks } from '@marmeon/http';
import { WebhooksConfig } from './config.ts';

export class WebhooksServiceProvider {
  boot(app: Application): void {
    // The sender's name is what the route says in `verifyWebhook('payments')`. The secret comes from the environment, never from the route file.
    app.container.make(Webhooks).define('payments', { scheme: 'stripe', secrets: app.container.make(WebhooksConfig).paymentsSecret });
    // Forged requests count too, so a client that guesses signatures is slowed down; a real sender sends far fewer.
    app.container.make(RateLimiter).for('webhooks.payments', (ctx) => Limit.perMinute(120).by(clientKey(ctx.ip)));
  }
}
