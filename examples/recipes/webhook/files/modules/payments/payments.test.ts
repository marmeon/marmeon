import { randomBytes } from 'node:crypto';
import { Queue } from '@marmeon/queue';
import { createTestApp, signedWebhook, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { InvoiceRepository } from './InvoiceRepository.ts';
import { IssueReceiptJob } from './jobs/IssueReceiptJob.ts';
import { WebhookEventRepository } from './WebhookEventRepository.ts';

// What the payment endpoint accepts, what it does once for each event, and what it leaves alone.

// A secret built at run time, so that no literal in the source looks like a real one to a scanner.
const SECRET = ['whsec', randomBytes(24).toString('hex')].join('_');

let app: TestApp;
// `csrf: true` checks requests as the app does: the sender sends no token, and the route needs none.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', csrf: true, env: { PAYMENTS_WEBHOOK_SECRET: SECRET } });
}, 30_000);

const paid = (id: string, invoice = 'inv_1001') => JSON.stringify({ id, type: 'invoice.paid', data: { invoice } });
/** Sends `body` as the provider would, signed with `SECRET` unless the test passes other headers. */
const send = (body: string, headers: Record<string, string> = signedWebhook('stripe', SECRET, body)) =>
  app.expectingJson().post('/webhooks/payments', { body, headers: { 'content-type': 'application/json', ...headers } });
const invoice = async () => (await app.make(InvoiceRepository).findBy('reference', 'inv_1001'))!;

describe('the payment webhook', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    await app.make(InvoiceRepository).insert({ reference: 'inv_1001', amount_cents: 4900 });
  });

  it('marks the invoice as paid and queues its receipt', async () => {
    await send(paid('evt_1')).assertOk().assertExactJson({ received: true });

    expect((await invoice()).paid_at).not.toBeNull();
    app.queue.assertDispatchedTimes(IssueReceiptJob, 1);
    expect(app.queue.dispatched(IssueReceiptJob)[0]!.payload).toEqual({ invoiceId: (await invoice()).id });
    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0 });
    expect((await invoice()).receipt_issued_at).not.toBeNull();
  });

  it('does the work once when the provider sends an event again, also with a new signature', async () => {
    const body = paid('evt_1');
    await send(body).assertOk();
    const first = (await invoice()).paid_at;

    app.travel({ seconds: 60 });
    await send(body, signedWebhook('stripe', SECRET, body, { timestamp: new Date(app.clock.now()) })).assertOk().assertExactJson({ received: true });

    app.queue.assertDispatchedTimes(IssueReceiptJob, 1);
    expect((await invoice()).paid_at).toBe(first);
    await app.assertDatabaseCount('webhook_events', 1);
  });

  it('queues no second receipt when another event reports the same invoice', async () => {
    await send(paid('evt_1')).assertOk();
    await send(paid('evt_2')).assertOk();
    app.queue.assertDispatchedTimes(IssueReceiptJob, 1);
    await app.assertDatabaseCount('webhook_events', 2);
  });

  it('acknowledges an event it does not act on, and an invoice nobody knows', async () => {
    const other = JSON.stringify({ id: 'evt_2', type: 'customer.created', data: {} });
    await send(other).assertOk().assertExactJson({ received: true });
    await send(paid('evt_3', 'inv_unknown')).assertOk();
    app.queue.assertNothingDispatched();
    expect((await invoice()).paid_at).toBeNull();
  });

  it('refuses a body that does not have the shape of an event', async () => {
    const body = JSON.stringify({ type: 'invoice.paid' });
    await send(body).assertStatus(422);
    await app.assertDatabaseCount('webhook_events', 0);
  });

  it('keeps nothing of an event whose first delivery failed, so that the next one does the work', async () => {
    const queue = app.make(Queue);
    vi.spyOn(queue, 'dispatch').mockRejectedValueOnce(new Error('the queue is down'));

    await send(paid('evt_1')).assertStatus(500);
    expect((await invoice()).paid_at).toBeNull();
    await app.assertDatabaseCount('webhook_events', 0);

    await send(paid('evt_1')).assertOk();
    expect((await invoice()).paid_at).not.toBeNull();
    app.queue.assertDispatchedTimes(IssueReceiptJob, 1);
  });

  it('issues one receipt when the job runs twice', async () => {
    await send(paid('evt_1')).assertOk();
    expect(await app.queue.work()).toMatchObject({ processed: 1 });
    const issued = (await invoice()).receipt_issued_at;

    app.travel({ seconds: 60 });
    const { invoiceId } = app.queue.dispatched(IssueReceiptJob)[0]!.payload;
    await app.make(Queue).dispatch(IssueReceiptJob, { invoiceId });
    expect(await app.queue.work()).toMatchObject({ failed: 0 });
    expect((await invoice()).receipt_issued_at).toBe(issued);
  });

  it.runIf(process.env['DB_DRIVER'] === 'pgsql')('on Postgres, two events about one invoice that arrive together queue one receipt', async () => {
    // The test runs in one transaction on one connection, so the two requests are served one after the other; the condition in the
    // UPDATE is what lets only one of them through when the requests really overlap.
    await Promise.all([send(paid('evt_1')).assertOk(), send(paid('evt_2')).assertOk()]);
    app.queue.assertDispatchedTimes(IssueReceiptJob, 1);
  });

  it('refuses a request with no signature, a wrong one, a changed body or an old time, and changes nothing', async () => {
    const refused = { error: 'webhook_signature_invalid' };
    const body = paid('evt_1');
    await send(body, {}).assertUnauthorized().assertExactJson(refused);
    await send(body, signedWebhook('stripe', `${SECRET}-other`, body)).assertUnauthorized().assertExactJson(refused);
    await send(paid('evt_1', 'inv_2'), signedWebhook('stripe', SECRET, body)).assertUnauthorized().assertExactJson(refused);
    await send(body, signedWebhook('stripe', SECRET, body, { timestamp: new Date(app.clock.now() - 3_600_000) })).assertUnauthorized().assertExactJson(refused);

    expect((await invoice()).paid_at).toBeNull();
    app.queue.assertNothingDispatched();
    await app.make(WebhookEventRepository).query().select('id').execute().then((rows) => expect(rows).toEqual([]));
  });

  it('answers 429 once a client has sent 120 requests in a minute, signed or not', async () => {
    for (let count = 0; count < 120; count++) await send('{}', {}).assertUnauthorized();
    await send(paid('evt_1')).assertStatus(429);
    app.travel({ seconds: 61 });
    await send(paid('evt_1')).assertOk();
  });
});
