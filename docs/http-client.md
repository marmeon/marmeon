# HTTP Client

## Introduction

Your app sometimes sends a request to a server somebody else named: a webhook address an editor typed in, an avatar's URL, a feed to
import. The address decides where your server connects, so a request to `http://169.254.169.254/` or to `http://localhost:5432/`
reaches your own network from the inside. `HttpClient` of `@marmeon/fetch` refuses such addresses, and it follows redirects itself, so
a public server cannot send your request on to a private one:

```ts title="modules/hooks/controllers/PingHookController.ts"
import { FetchError, HttpClient } from '@marmeon/fetch';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const PingHookRequest = defineRequest({
  // The rule checks the form of the address. Whether it may be reached is decided when the request is sent.
  schema: r.object({ url: r.string().trim().url() }),
});

export class PingHookController extends Controller {
  static request = PingHookRequest;
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    super();
    this.#http = http;
  }

  async handle(ctx: ContextOf<typeof PingHookRequest>) {
    try {
      const response = await this.#http.fetch(ctx.body.url, { method: 'POST', json: { ping: true }, timeout: 5 });
      await response.body?.cancel();
      return this.json({ status: response.status });
    } catch (error) {
      if (error instanceof FetchError) throw new ValidationError({ url: [`The address was not pinged: ${error.reason}.`] }, ctx.body);
      throw error;
    }
  }
}
```

```ts title="modules/hooks/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { PingHookController } from './controllers/PingHookController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).authorize(everyone).post('/hooks/ping', PingHookController);
});
```

The route is for signed-in editors, so the controller shows them the `reason`. On a form that anyone can reach, answer one message for
every `FetchError` and write the `reason` to the log: `refused` against `network` would tell a stranger what your server can reach.

## Installation

A new app has `@marmeon/fetch`. Otherwise add it with [`marmeon add`](packages.md#introduction), in the version of the app's other framework packages:

```sh
pnpm marmeon add fetch
```

Where [`marmeon add`](packages.md#packages-you-add) refuses (yarn, bun, a workspace and the other cases listed there), run `pnpm add -E @marmeon/fetch@<version of your app>`.

The package registers itself: the `HttpClient` is in the container, and a controller or a job asks for it in its constructor.

## Sending a request

`fetch(input, options)` takes an address, as text or a `URL`, and resolves with a standard `Response`. A `404` or a `500` is a
response, not an error. The options:

| Option | Effect |
| --- | --- |
| `method` | The method. Default `GET`. `CONNECT`, `TRACE` and `TRACK` cannot be sent. |
| `headers` | A `Headers` or an object. |
| `body` | A string, bytes or a `URLSearchParams`, which is sent as a form. Not for `GET` and `HEAD`. |
| `json` | A value sent as JSON, with `content-type: application/json`. Not together with `body`. |
| `timeout` | For the whole request: every redirect and the reading of the body. A [`Duration`](time.md#spans-of-time): a number is seconds, `{ milliseconds: 500 }` is shorter. Default 15 seconds. |
| `maxResponseBytes` | The largest body, in bytes. Default 5 MiB. |
| `redirect` | `follow` (default), `manual` returns the redirect response, `error` throws when the response redirects. |
| `maxRedirects` | Default `3`. |
| `signal` | An `AbortSignal` that ends the request at any stage. |

Read the body or cancel it: an unread body holds its connection. A header that frames or routes the request (`content-length`,
`transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`, `keep-alive`, `expect`, `host`, `proxy-*`) belongs to the transport,
so passing one is a `TypeError`, as is an address text that `new URL()` cannot read.

## What is refused

The client refuses a request, with a `FetchError` whose `reason` is `refused`, when:

- the address is not `http` or `https`, or carries a user name or a password (send credentials in a header), whether it is the one you passed or a redirect target;
- the host is an IP address that is not public: loopback, private ranges, link-local (the cloud metadata address), multicast,
  documentation ranges and the IPv6 forms that embed one of them (`::ffff:10.0.0.1`);
- the host is a name that resolves to such an address. The transport resolves the name, checks every address it resolves to and
  connects only to a checked one, so a name that answers differently a second time gains nothing;
- a redirect leads to such a host or from `https` to `http`. Every hop is checked as the first request was.

Across origins a redirect keeps only `accept`, `accept-language` and `user-agent`: an API key or a token never follows. A redirect
to another origin that would send the body again (`307`, `308`, or a `301` or `302` of a `PUT` or `DELETE`) is refused.

The check happens when the request is sent. A rule that tests the address while the form is validated tells you only the form of the
address: the name may resolve elsewhere a second later, or the server may redirect. Keep the validation rule (`r.string().url()`) for
the editor's convenience and let `fetch()` decide.

## Errors

`fetch()` throws a `FetchError`. Its `reason` says why:

| `reason` | Meaning |
| --- | --- |
| `refused` | The address policy, or an address that cannot be sent: a scheme other than `http` and `https`, credentials in the address, a redirect from `https` to `http`. |
| `timeout` | A time limit ran out, the reading of the body included. |
| `aborted` | Your own `signal`. It is the `cause`. |
| `network` | Resolution, connection or transfer failed. |
| `too-large` | The response is bigger than `maxResponseBytes`. A declared `content-length` above the limit throws from `fetch()`; a body that grows past it fails when you read it. |
| `redirects` | More redirects than `maxRedirects`, or any redirect with `redirect: 'error'`. |

The address a host resolved to is in the `cause`, never in the message, so a message is safe to show an editor. Options that cannot
be sent, such as a header that frames the request, throw a `TypeError`: they are a mistake in your code, not a failure of the
network.

## Reaching your own network

Some requests are meant for a private address: a service in your cluster, a mail relay's API. List the ranges, as CIDR ranges and
never as host names, in `FETCH_ALLOWED_ADDRESSES`, and every request may reach them. To allow them for one integration only,
use `allowing()`:

```ts
const internal = this.#http.allowing(['10.20.0.0/16']);
await internal.fetch('http://10.20.3.4/status');
```

`allowing()` returns a new client and leaves the first as it was. A range that is not a range is a `TypeError`.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `FETCH_DRIVER` | `direct` | The transport that sends the request. `direct` resolves, checks and connects itself; a package can bring more (see [Fetch transports](drivers.md#fetch-transports)); a name nobody brought stops the start. |
| `FETCH_ALLOWED_ADDRESSES` | empty | Address ranges that may be reached although they are not public, comma-separated: `10.20.0.0/16,fd00::/8`. An entry that is not a range stops the start. |

No environment allows loopback or a private network by itself: not development, not tests.

## Testing

A test app replaces the `HttpClient` with `HttpClientFake` as `app.http`. It opens no connection, judges the address as the real
client does, and answers from the replies you register:

```ts title="modules/hooks/ping.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('pings the address of the hook', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const editor = await app.factory(UserFactory).create();
  app.http.respond('https://hooks.example.com/in', new Response('ok'));
  await app.actingAs(editor).post('/hooks/ping', { json: { url: 'https://hooks.example.com/in' } }).assertOk();
  app.http.assertSent('https://hooks.example.com/in');
});
```

A request nobody answered throws `FetchError('network')`, so a test never reaches the network. The [fakes](fakes.md#outgoing-requests)
page lists every method and what the fake refuses.
