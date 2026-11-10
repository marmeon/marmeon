# Webhooks

## Introduction

A webhook is a request that another service sends to your app when something happens there: a payment went through, a repository
got a push. Nobody is signed in, there is no session and no CSRF token, so anyone who knows the address could send the same
request. What tells a real one from a forged one is the **signature** the sender adds: a hash of the request, made with a secret
that only the sender and your app know.

`verifyWebhook()` checks that signature before your route runs. It reads the headers, the time and the body, compares the signature
in constant time, and answers `401` for anything that does not hold. A route behind it needs no `csrfExcept`.

## Defining a sender

Define each sender once, in a service provider's `boot()`, under a name of your choice. The secret comes from the app's
[configuration](configuration.md), which reads the environment, and never from a route file or from the code:

```ts title="modules/billing/BillingServiceProvider.ts"
import type { Application } from '@marmeon/core';
import { Webhooks } from '@marmeon/http';
import { BillingConfig } from './config.ts';

export class BillingServiceProvider {
  boot(app: Application): void {
    const config = app.container.make(BillingConfig);
    app.container.make(Webhooks).define('payments', { scheme: 'standard', secrets: config.webhookSecret });
  }
}
```

`define()` checks the definition at once and throws an error with the code [H12](errors.md#server-error-codes) when it cannot work:
the name is taken, there is no secret, a secret is too short or not in the scheme's format, the scheme is unknown, or the tolerance is
out of range. The error names the sender and never prints the secret.

| Option | Meaning |
|---|---|
| `scheme` | How the sender signs: `'standard'`, `'stripe'` or `'github'` (see below). |
| `secrets` | A secret, or a list of them. Any one of them may have signed the request. |
| `tolerance` | How far the request's time may be from the app's clock, either way. Default 5 minutes, at most 30. |

## Putting it on a route

```ts title="modules/billing/routes.ts"
import { defineRoutes, everyone, verifyWebhook } from '@marmeon/http';
import { ReceivePaymentController } from './controllers/ReceivePaymentController.ts';

export default defineRoutes((Route) => {
  Route.authorize(everyone).middleware(verifyWebhook('payments')).post('/webhooks/payments', ReceivePaymentController);
});
```

A route that names a sender nobody defined stops the app at start-up with [H12](errors.md#server-error-codes), and the message shows
how to define it. `verifyWebhook()` declares that it [ensures](middleware.md#declaring-what-a-middleware-ensures) `'authenticated'`: only
the holder of the secret gets past, so [`marmeon check`](check.md) does not report the route as an unprotected write.

The route needs no [`csrfExcept`](csrf.md#excluding-paths). The CSRF check skips exactly the routes that have `verifyWebhook()` on
them. A route beside it without the middleware stays protected.

Behind it, the context carries `ctx.webhook`:

```ts
export class ReceivePaymentController extends Controller {
  async handle(ctx: HttpContext<{ webhook: WebhookContext }>) {
    const { id, timestamp, body } = ctx.webhook; // the sender's delivery id, when it signed, the body as text
    const event = await ctx.input(); // the same body, parsed
    // …
  }
}
```

The router reads the body once, as bytes. The signature is checked over those bytes, and `ctx.input()` parses those same bytes, so
what was verified is exactly what you read. A body larger than the app's limit answers `413`, as everywhere.

## The formats

Each scheme is the sender's own format and uses HMAC-SHA256.

| Scheme | Headers | Signed content | Secret |
|---|---|---|---|
| `standard` | `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`, several separated by spaces) | `<id>.<timestamp>.<body>` | `whsec_` and base64 of at least 24 bytes, as the sender shows it |
| `stripe` | `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>]` | `<t>.<body>` | At least 16 characters, used as it is |
| `github` | `X-Hub-Signature-256: sha256=<hex>`, `X-GitHub-Delivery` | the body | At least 16 characters, used as it is |

`ctx.webhook.id` is the `webhook-id` of the `standard` format, which the signature covers. The `github` format's id is the
`X-GitHub-Delivery` header, which the signature does not cover: whoever replays a recorded request can change it, so it is no
defence against a replay. The `stripe` format has no id header; its events carry theirs in the signed body. The `github` format sends
no time either, so `ctx.webhook.timestamp` is `undefined` and no window applies: a recorded request stays valid for good.

For the formats with a time, the time must be a whole number of seconds, and the app's clock must be within the tolerance of it.
A time in milliseconds, with a fraction or a sign, or outside the window, is refused. The window uses the app's
[clock](time.md), so tests can move it.

## What 401 means

A missing header, a header that is sent twice or is empty, a malformed or too long list of signatures, a signature of another
secret or another body, a time that is not a whole number of seconds, or a time outside the tolerance: all of these answer the same
`401` with `{ "error": "webhook_signature_invalid" }`. The answer says nothing about which check failed, and nothing the request
carried (body, signature or secret) is written to a log or to the message. Your route does not run.

Check the secret first when a real sender is refused: that it is the one of this endpoint, that it has no extra space or line
break, and that the server's clock is right.

## Idempotence

A sender sends the same event again until it gets a `2xx` answer, and may send it twice even then. `verifyWebhook()` does not
remember what it saw: locking an id when it checks would lose the event whose first delivery failed. Make the handler idempotent
instead, by storing an id with a unique index and ignoring the repeat. Use `ctx.webhook.id` for `standard`, and the event's `id`
in the signed body for `stripe`. For `github` neither the delivery id nor a time protects against a replay: make the effect itself
idempotent, or fetch the current state from the sender's API instead of trusting the payload.

```ts
const inserted = await this.#events.tryInsert({ id: event.id, type: event.type });
if (!inserted.ok) return this.json({ received: true }); // seen before: the unique index on `id` refused it
```

## Rotating a secret

Give `secrets` both the new and the old secret, change the secret at the sender, and take the old one out after the last request
signed with it has arrived:

```ts
define('payments', { scheme: 'standard', secrets: [config.webhookSecret, config.previousWebhookSecret] });
```

Every secret is tried against every signature the request lists, so a sender that signs with both while it rotates works too.

## Testing

`signedWebhook()` of `@marmeon/testing` returns the headers a sender would send. Sign the exact string you send:

```ts
import { signedWebhook } from '@marmeon/testing';

const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
await app
  .post('/webhooks/payments', { body, headers: { 'content-type': 'application/json', ...signedWebhook(body, { scheme: 'standard', secret }) } })
  .assertOk();
```

The body comes first and the options name the rest: `scheme` and `secret` are required, `id` and `timestamp` (a `Date`) set the delivery id and the time, and the defaults are a random id and now. Test the refusal
too: send the body with no headers, with another secret's signature, and with `timestamp` an hour in the past, and assert `401`.
Build the secret in the test (`['whsec', Buffer.from(bytes).toString('base64')].join('_')`) rather than writing one as a literal:
a literal that looks like a real secret is refused by code hosts that scan for them.
