import { createTestApp, signedWebhook, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WebhooksConfig } from './config.ts';

let app: TestApp;
let SECRET: string;
beforeEach(async () => {
  app = await createTestApp(application);
  SECRET = app.make(WebhooksConfig).paymentsSecret;
}, 30_000);

const event = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
const send = (body: string, headers: Record<string, string>) =>
  app.expectingJson().post('/webhooks/payments', { body, headers: { 'content-type': 'application/json', ...headers } });

describe('the payment webhook', { timeout: 30_000 }, () => {
  it('takes an event signed with the secret', async () => {
    await send(event, signedWebhook('stripe', SECRET, event)).assertOk().assertExactJson({ received: 'invoice.paid' });
  });

  it('refuses an event with no signature, a wrong one, a changed body or an old time', async () => {
    const refused = { error: 'webhook_signature_invalid' };
    await send(event, {}).assertUnauthorized().assertExactJson(refused);
    await send(event, signedWebhook('stripe', `${SECRET}-other`, event)).assertUnauthorized().assertExactJson(refused);
    await send(event.replace('paid', 'refunded'), signedWebhook('stripe', SECRET, event)).assertUnauthorized().assertExactJson(refused);
    await send(event, signedWebhook('stripe', SECRET, event, { timestamp: new Date(Date.now() - 3_600_000) })).assertUnauthorized().assertExactJson(refused);
  });
});
