# A Payment Webhook

## Introduction

This recipe adds an endpoint that a payment provider calls, on an app made from the [starter kit](starter-kit.md). When a customer
pays, the provider sends the app an `invoice.paid` event; the app marks the invoice as paid and queues a job that issues the
receipt. Nobody is signed in on this request, and the address is public: anyone can send the same request, and the provider sends
the real one again whenever it does not get a `2xx` answer. Two things have to hold. Only the provider may change an invoice,
and an event changes it once, however often it arrives.

It protects against these mistakes:

- **A forged event.** `verifyWebhook('payments')` checks the signature over the exact bytes of the body, in constant time, before
  the controller runs; a request without a valid one gets `401` and changes nothing. The secret comes from the environment through
  the module's configuration, never from the code.
- **A signed request that is sent again later.** For the `stripe` scheme used here the signed time must be within five minutes
  of the app's clock, so a recorded request stops working. The `github` scheme sends no time at all; see
  [what the github scheme does not protect against](#what-the-github-scheme-does-not-protect-against).
- **An event that is handled twice.** The provider repeats an event until it answers `2xx`, and may send it twice even then. The
  controller writes the event's id into `webhook_events`, whose unique index lets the first delivery in and refuses every repeat,
  also two that arrive at the same moment. The id comes from the signed body.
- **Half of the work.** The note of the event, the change of the invoice and the queued job are written in one
  `connections.transaction()`. When the queue or the database fails, nothing is kept, and the provider's next delivery does the
  work. Locking the id before the work would lose exactly that event.
- **A job that runs twice.** The queue runs a job *at least once*. The receipt job reads the invoice when it runs and does nothing
  when the receipt was issued; see [at least once](queues.md#at-least-once).
- **A body of the wrong shape.** The signed body is parsed by the same bytes that were verified, then checked against a schema.
  An event the app does not act on is acknowledged with `200` and leaves everything alone.
- **A client that guesses signatures.** `throttle()` comes before `verifyWebhook()` on the route, so forged requests count against
  the client's limit too.
- **A missing CSRF token.** The route needs no `csrfExcept`: the CSRF check skips exactly the routes that have `verifyWebhook()`,
  and a route beside it without the middleware stays protected.

## Generate

```sh
pnpm marmeon make:module payments
pnpm marmeon make:migration create_invoices_table --module=payments
pnpm marmeon make:migration create_webhook_events_table --module=payments
pnpm marmeon make:controller ReceivePaymentEvent --module=payments --request
pnpm marmeon make:job IssueReceipt --module=payments
pnpm marmeon make:test payments --module=payments --path=/webhooks/payments
```

`make:module` writes the module and adds it to `modules` in `bootstrap/app.ts`. `make:migration` writes the two migrations with
the current time in their file names, so yours have other names than the ones below; put the code below into your files, in this
order. `make:controller` writes the controller with its request, `make:job` writes the job class with the stable name
`payments.issue-receipt` and lists it in the module's `index.ts`, and `make:test` writes a test that stays red until the code
below replaces it. Do not migrate yet: the migrations are still the generator's stubs.

There is no generator for the configuration, the service provider and the repositories; the recipe writes them as the
[configuration](configuration.md), [service provider](providers.md) and [queries](queries.md) pages show.

## What it writes

| File | Purpose |
| --- | --- |
| `.env.example` and `.env` | The name of the secret. |
| `modules/payments/config.ts` | Reads the secret from the environment. |
| `modules/payments/PaymentsServiceProvider.ts` | Defines the sender `payments` and the limiter. |
| `modules/payments/index.ts` | The module: its configuration, job, migrations, provider and route. |
| `modules/payments/routes.ts` | The endpoint, behind `throttle()` and `verifyWebhook()`. |
| `modules/payments/migrations/<timestamp>_create_invoices_table.ts` | The invoices. |
| `modules/payments/migrations/<timestamp>_create_webhook_events_table.ts` | The note of each handled event, with a unique index. |
| `modules/payments/InvoiceRepository.ts` | `markPaid()`. |
| `modules/payments/WebhookEventRepository.ts` | The notes of the events. |
| `modules/payments/controllers/ReceivePaymentEventController.ts` | Checks the shape of the event and does the work once. |
| `modules/payments/jobs/IssueReceiptJob.ts` | Issues the receipt, once. |
| `modules/payments/payments.test.ts` | The tests of the module. |

## The code

### The secret and the sender

The provider's dashboard shows the secret that signs the requests to your endpoint. It goes into the environment, with a
placeholder in `.env.example` that tells the next developer what to put there.

```sh title=".env.example"
NODE_ENV=development
# The secret your payment provider signs its webhook requests with (modules/payments): `verifyWebhook('payments')` refuses anything else.
PAYMENTS_WEBHOOK_SECRET=replace-with-the-secret-the-provider-shows
```

Put the real secret into `.env` on your machine, and into the real environment on a server. Never commit it.

```sh title=".env"
NODE_ENV=development
# The secret your payment provider signs its webhook requests with (modules/payments): `verifyWebhook('payments')` refuses anything else.
PAYMENTS_WEBHOOK_SECRET=replace-with-the-secret-the-provider-shows
```

The module's configuration reads it, so the app refuses to start without it, with a message that names the variable and never
prints its value.

```ts title="modules/payments/config.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** The secret a payment provider signs its requests with — shown in the provider's dashboard, kept in the environment. */
export const PaymentsConfig = defineConfig('payments', {
  env: env({
    PAYMENTS_WEBHOOK_SECRET: env.string().required("Missing — copy the signing secret of the endpoint from the provider's dashboard"),
  }),
  resolve: (e) => ({ webhookSecret: e.PAYMENTS_WEBHOOK_SECRET }),
});
export type PaymentsConfig = ConfigOf<typeof PaymentsConfig>;
```

The sender is defined once, in a service provider's `boot()`, under the name the route will use. `define()` checks the definition
at once: a secret that is missing or too short stops the app at start-up with error
[H12](errors.md#server-error-codes). The same provider defines the limiter, as [rate limiting](rate-limiting.md#defining-limiters)
describes. It counts by the client's address, because nobody is signed in. A provider sends from few addresses, so size the
limit to its peak and set `SERVER_TRUSTED_PROXIES` when the app runs behind a proxy: otherwise every request shares one address. A
`429` only makes the provider retry later.

```ts title="modules/payments/PaymentsServiceProvider.ts"
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
```

The `stripe` scheme is the provider's own format: `Stripe-Signature: t=<seconds>,v1=<hex>` over `<t>.<body>`. The `standard` and
`github` schemes work the same way on the route; the [webhooks](webhooks.md#the-formats) page lists the three.

```ts title="modules/payments/index.ts"
import { defineModule } from '@marmeon/core';
import { PaymentsConfig } from './config.ts';
import { IssueReceiptJob } from './jobs/IssueReceiptJob.ts';
import { PaymentsServiceProvider } from './PaymentsServiceProvider.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'payments',
  config: [PaymentsConfig],
  jobs: [IssueReceiptJob],
  migrations: new URL('./migrations/', import.meta.url),
  providers: [PaymentsServiceProvider],
  routes,
});
```

### The route

The route is open to everyone, which `authorize(everyone)` says on purpose, and signed by the sender. Nobody has a session, so
the access check that stands for the whole route is the signature. `verifyWebhook()` declares that it ensures
`'authenticated'`, so [`marmeon check`](check.md) does not report the route as an unprotected write.

The order matters. `throttle()` comes first, so that a request with a forged signature is counted before the signature is
computed. `verifyWebhook()` follows, and the controller runs only for a request that passed it.

```ts title="modules/payments/routes.ts"
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone, verifyWebhook } from '@marmeon/http';
import { ReceivePaymentEventController } from './controllers/ReceivePaymentEventController.ts';

export default defineRoutes((Route) => {
  // Open to everyone, signed by the sender: no session and no token, so no `csrfExcept` either. The throttle comes first: a forged
  // request counts too.
  Route.authorize(everyone).middleware(throttle('webhooks.payments')).middleware(verifyWebhook('payments')).post('/webhooks/payments', ReceivePaymentEventController);
});
```

### The tables

The invoice is the thing the event changes: when it was paid and when its receipt was issued, both empty to begin with. The
second table is the app's memory of what it has handled. Its one purpose is the unique index on `event_id`.

```ts title="modules/payments/migrations/2026_10_26_000000_create_invoices_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('invoices', (table) => {
      table.id();
      table.string('reference', 80).unique();
      table.integer('amount_cents');
      table.timestamp('paid_at').nullable();
      table.timestamp('receipt_issued_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('invoices'),
});
```

```ts title="modules/payments/migrations/2026_10_26_000001_create_webhook_events_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('webhook_events', (table) => {
      table.id();
      // The sender's id of the event. The unique index lets the first delivery in and refuses every repeat, however many arrive at once.
      table.string('event_id', 255).unique();
      table.string('type', 100);
      table.timestamps();
    }),
  down: (schema) => schema.drop('webhook_events'),
});
```

Keep the notes for as long as the provider may send an event again. A retry carries the original event id and a new time, so the
signed time does not make an old retry impossible, and a note that was pruned too early would let the effect run a second time.

### The repositories

`markPaid()` is the effect. It answers `undefined` when the invoice does not exist or is already paid, so that a second event for
the same invoice, with an id of its own, queues no second receipt. The condition `paid_at is null` sits in the `UPDATE` itself:
a read followed by an update would let two events that arrive together both see an unpaid invoice, and the customer would get two
receipts. Do the same for anything that must happen once, such as a refund.

```ts title="modules/payments/InvoiceRepository.ts"
import { Repository, type Row } from '@marmeon/database';

export class InvoiceRepository extends Repository<'invoices'> {
  static table = 'invoices' as const;

  /** Marks the invoice with this reference as paid; the invoice, or `undefined` when there is none or it was paid already. */
  async markPaid(reference: string, paidAt: string): Promise<Row<'invoices'> | undefined> {
    // One statement: the condition `paid_at is null` sits in the UPDATE, so two events for one invoice cannot both pass a check
    // before either writes. Reading first and updating after would let both of them queue a receipt.
    return this.db.updateTable('invoices').set({ paid_at: paidAt, updated_at: paidAt }).where('reference', '=', reference).where('paid_at', 'is', null).returningAll().executeTakeFirst();
  }
}
```

```ts title="modules/payments/WebhookEventRepository.ts"
import { Repository } from '@marmeon/database';

/** The events that were handled, by the id the sender gave them. The unique index on `event_id` is what makes a repeat visible. */
export class WebhookEventRepository extends Repository<'webhook_events'> {
  static table = 'webhook_events' as const;
}
```

### The controller

The request definition checks the shape of the body that was verified, and the controller reads `ctx.body`. A body that is not
an event answers `422`. Fields the schema does not name are left out, so a provider that adds fields breaks nothing.

The work is one transaction. `tryInsert()` writes the note of the event. It does not throw on a repeat: it returns an `err` of
kind `duplicate` from the unique index, even for two requests at the same moment, and the controller leaves with nothing done. For
a first delivery, the invoice is marked and the job is queued. On the database queue the job is a row in the same transaction,
so it is there with the commit and gone with a rollback; a worker never reads an invoice that is not committed. See
[transactions](transactions.md) and [queues](queues.md#inside-a-transaction).

```ts title="modules/payments/controllers/ReceivePaymentEventController.ts"
import { Clock } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { InvoiceRepository } from '../InvoiceRepository.ts';
import { IssueReceiptJob } from '../jobs/IssueReceiptJob.ts';
import { WebhookEventRepository } from '../WebhookEventRepository.ts';

/** The signed body, checked before the controller reads it. Fields the schema does not name are left out. */
export const PaymentEventRequest = defineRequest({
  schema: r.object({
    id: r.string().min(1).max(255),
    type: r.string().max(100),
    data: r.object({ invoice: r.string().max(80).optional() }).optional(),
  }),
});

/**
 * A payment provider's event. By the time this runs `verifyWebhook('payments')` has checked the signature and the time, and the
 * schema has checked the shape of the body. The provider repeats an event until it gets a `2xx`, so the effect runs once per event id.
 */
export class ReceivePaymentEventController extends Controller {
  static request = PaymentEventRequest;

  readonly #connections: Connections;
  readonly #events: WebhookEventRepository;
  readonly #invoices: InvoiceRepository;
  readonly #queue: Queue;
  readonly #clock: Clock;

  constructor(connections: Connections, events: WebhookEventRepository, invoices: InvoiceRepository, queue: Queue, clock: Clock) {
    super();
    this.#connections = connections;
    this.#events = events;
    this.#invoices = invoices;
    this.#queue = queue;
    this.#clock = clock;
  }

  async handle(ctx: ContextOf<typeof PaymentEventRequest>) {
    const event = ctx.body;
    const reference = event.data?.invoice;
    // An event this app does not act on is acknowledged, or the sender would repeat it for days.
    if (event.type !== 'invoice.paid' || reference === undefined) return this.json({ received: true });

    // One transaction: the note of the event, the payment and the queued job all count, or none does. When anything fails, the sender's
    // next delivery finds no note and does the work again. The queued job is a row in this transaction, so a worker never sees it early.
    await this.#connections.transaction(async () => {
      const first = await this.#events.tryInsert({ event_id: event.id, type: event.type });
      if (!first.ok) return; // seen before: the unique index on `event_id` refused it
      const invoice = await this.#invoices.markPaid(reference, new Date(this.#clock.now()).toISOString());
      if (invoice) await this.#queue.dispatch(IssueReceiptJob, { invoiceId: invoice.id });
    });
    return this.json({ received: true });
  }
}
```

The id of the event comes from the signed body. The `stripe` format has no id header, and for `standard` the body's id is as good
as `ctx.webhook.id`, the `webhook-id` the signature covers. Use whichever the sender signs. The `github` delivery id is not
signed, see below.

Answering `200` for a type the app does not act on, and for an invoice it does not know, is deliberate: the provider would send
them again for days, and there is nothing to fix. If you want to learn of an unknown invoice, log its reference (not the body)
and answer `200` anyway.

### The job

The job is where the slow part of the work belongs; here it is only a stamp, with a comment where the receipt itself goes. Its
payload is the invoice's id and nothing else. A job can run twice, so it does nothing for an invoice that has the stamp.

```ts title="modules/payments/jobs/IssueReceiptJob.ts"
import { Clock } from '@marmeon/core';
import type { JobContext, JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { InvoiceRepository } from '../InvoiceRepository.ts';

/** Issues the receipt of a paid invoice. The payload holds the invoice's id; the job reads the invoice as it is when it runs. */
export class IssueReceiptJob {
  /** Stable — the queue stores this name, never the class name. */
  static readonly job = 'payments.issue-receipt';
  static readonly schema = r.object({ invoiceId: r.integer() });
  static readonly tries = 3;
  static readonly backoff = [10, 60];

  readonly #invoices: InvoiceRepository;
  readonly #clock: Clock;

  constructor(invoices: InvoiceRepository, clock: Clock) {
    this.#invoices = invoices;
    this.#clock = clock;
  }

  async handle(payload: JobPayload<typeof IssueReceiptJob>, job: JobContext): Promise<void> {
    const invoice = await this.#invoices.find(payload.invoiceId);
    if (!invoice) return job.discard('the invoice is gone');
    // A job can run twice; the stamp is what keeps the second run from issuing another receipt.
    if (invoice.receipt_issued_at !== null) return;
    // The receipt itself (a PDF, a mail) goes here.
    await this.#invoices.update(invoice.id, { receipt_issued_at: new Date(this.#clock.now()).toISOString() });
  }
}
```

Once the code above is in place, create the tables, write their columns into the app's types, and write the types of the new
route:

```sh
pnpm marmeon migrate
pnpm marmeon db:types
pnpm marmeon route:types
```

## The test

Each test names one of the dangers above. The app is created with `csrf: true` and a secret of its own, so the tests show that
the sender needs no token and that the secret comes from the environment. The secret is built at run time from `whsec_` and
random bytes: a literal that looks like a real secret is refused by code hosts that scan for them.

`signedWebhook()` of `@marmeon/testing` returns the headers a sender would send. Sign the exact string you send.

- A signed `invoice.paid` marks the invoice, queues one job, and the job issues the receipt.
- The same body sent again, with a new signature a minute later, does nothing more: one job, one note, the payment time as before.
- A different event about the same invoice queues no second receipt.
- An event of another type and an unknown invoice are acknowledged and leave the data alone.
- A body without an id is a `422`, and no note is written.
- When the queue fails on the first delivery, the answer is `500` and nothing is kept; the delivery after it does the work.
- On Postgres, two events about one invoice sent together queue one receipt.
- A job that runs twice issues one receipt.
- A request without a signature, with another secret's signature, with a changed body and with a time an hour old is refused with
  `401`, and the invoice, the queue and the notes are untouched.
- A client that sent 120 requests in a minute gets `429`, until the minute is over.

```ts title="modules/payments/payments.test.ts"
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
```

## Check

```sh
pnpm marmeon check
pnpm marmeon route:list
```

`marmeon check` reports no unprotected write for the route, because `verifyWebhook()` declares what it ensures, and finds no job
that no module lists. `route:list` shows the middleware of the endpoint: `throttle:webhooks.payments` and
`verifyWebhook:payments` at its end, in that order. A write route in this module without them would show without.

To try it by hand, sign a body yourself with the secret from `.env` and send it with `curl`; the format is on the
[webhooks](webhooks.md#the-formats) page. Most providers can also send a test event from their dashboard to the address of a
running app.

## What the github scheme does not protect against

The three formats are not equally strong. `standard` and `stripe` sign a time, and the app refuses a time that is outside its
tolerance (five minutes by default). The `github` format signs the body and nothing else:

- It sends **no timestamp**, so `ctx.webhook.timestamp` is `undefined` and no window applies. A request that someone recorded
  stays valid for good, and `verifyWebhook()` cannot tell a replay of it from the sender's own repeat.
- Its delivery id, `X-GitHub-Delivery`, is **not covered by the signature**. Whoever replays a recorded request can change the
  header, so an id note keyed by it does not stop a replay.

So with this scheme the note of the event does not protect against an attacker; it only keeps the sender's honest repeats from
running twice. Make the effect idempotent in itself: set a state instead of adding to one, or take the current state from the
sender's API instead of trusting the payload. Nothing that is dangerous to do twice, such as a refund or a mail to a customer,
should hang on a payload of this scheme alone.

## Where to go next

- [Webhooks](webhooks.md) for the three formats, rotating a secret and what a `401` means.
- [Transactions](transactions.md) for what joins a transaction and returning an `err`.
- [Queues](queues.md#inside-a-transaction) for jobs dispatched in a transaction.
- [Rate limiting](rate-limiting.md) for limiters and their keys.
- [Queries](queries.md#writing) for `tryInsert()` and the `duplicate` error of a unique index.
