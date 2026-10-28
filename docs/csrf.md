# CSRF Protection

## Introduction

Cross-site request forgery is a page on another site that makes a visitor's browser send a request to your app. The browser
adds your app's cookies, so the request arrives as the signed-in user, who never meant to send it. Marmeon refuses such requests
for every route of the `web` group. You do not have to do anything for your own forms:

```ts title="modules/notes/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { StoreNoteController } from './controllers/StoreNoteController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).authorize(everyone).post('/notes', StoreNoteController).name('notes.store');
});
```

A form on a page of your app posts to this route as it is. A page on another site that posts to it gets a 403. The check is the
`VerifyCsrfToken` middleware of the session package, and it runs for every request that may change something: every method but
`GET`, `HEAD` and `OPTIONS`.

## How a request is checked

The check asks three questions in turn. The first one that decides wins:

1. **What does the browser say?** Current browsers send `Sec-Fetch-Site` with every request. `same-origin` passes: a page of
   your app sent it, and no page can forge the header. `same-site`, from another subdomain, and `cross-site` are refused with a
   403, unless their `Origin` is one you trust.
2. **Where does the request come from?** Without `Sec-Fetch-Site`, or with `none`, the `Origin` header decides. Your app's own
   origin and the origins you trust pass. Any other origin is refused with a 403, and so is `null`, which a sandboxed frame or a
   redirect across sites sends.
3. **Does it carry the token?** A request with neither header, such as one from a script or `curl`, must send the session's
   token. Without it, or without a session, the answer is a 419, "Page Expired".

The browser's word comes first because it cannot be faked by a page and needs no state. A visitor can sign in without a session
and without a token, and no session is started just to hand one out.

Your app's own origin is the scheme and host the request reached it at, and the origin of `APP_URL`. Behind a proxy, the scheme
and host come from its `X-Forwarded-Proto` and `X-Forwarded-Host`, but only when the proxy is in `SERVER_TRUSTED_PROXIES`. `APP_URL`
lets the configured address through even before you trust the proxy. The [deployment](deployment.md#trusted-proxies) page
explains trusted proxies.

## Forms and JavaScript

The client core sends the token by itself. Every write it makes, from a `<Form>`, `useForm()` or an action, carries the
`X-XSRF-TOKEN` header with the value of the `XSRF-TOKEN` cookie, when the session has one. The browser sends Fetch Metadata along
anyway, so the token is a second line.

A `<Form>` also works without JavaScript, and so does a [link that sends](navigation.md#links-that-send). It then posts as a
plain HTML form, and writes the token into a hidden `_token` field when the page has one. A guest's page has none and needs none: the browser's headers carry the guest's form.

### The token

A session makes its token when something first needs it: the token is drawn on demand, never for a session that never hands one
out. The first page of a session that is kept carries it, and the `XSRF-TOKEN` cookie comes with every response of such a
session. The cookie is readable by your page's JavaScript and not encrypted, so a script can copy it into the header. It has no
`Max-Age`, like the session cookie: the browser drops it when it closes. `xsrfToken()` from `@marmeon/http/client` reads it for
your own `fetch`.

Signing in and signing out give the session a new token at once. A form from before the sign-in then carries the old token, but
it still passes by the browser's word.

To hand the token out yourself, inject the `Session` and call `token()`. The session is then kept, so the token is still valid
when it comes back:

```ts title="modules/notes/controllers/ShowEmbedController.ts"
import { Controller } from '@marmeon/http';
import { Session } from '@marmeon/session';

export class ShowEmbedController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle() {
    return this.json({ csrf: this.#session.token() });
  }
}
```

A client sends it back as the `_token` field, or in the `X-CSRF-TOKEN` or `X-XSRF-TOKEN` header. The comparison takes constant
time.

## Trusting other origins

An admin panel on another subdomain that posts to your app needs its origin listed. `CSRF_TRUSTED_ORIGINS` takes whole origins,
separated by commas:

```sh
CSRF_TRUSTED_ORIGINS=https://admin.example.com,https://example.org
```

An origin is a scheme, a host and an optional port, without a path. A value with a path, or a scheme other than `http` and
`https`, stops the app at start-up with a configuration error.

## Excluding paths

A request that another service signs, such as the webhook of a payment provider, needs no entry here: put
[`verifyWebhook()`](webhooks.md) on its route, and the CSRF check skips that route, and only that route. For the requests that
cannot carry a token, come from no browser and carry no signature either, a module lists the paths in `csrfExcept`. The pattern covers the whole path, and its characters are literal except two: `*` matches within one path segment (`/hooks/*` covers `/hooks/a`, not `/hooks/a/b`), and `**` matches any characters, `/` included:

```ts title="modules/billing/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'billing',
  routes,
  csrfExcept: ['/webhooks/*', '/callbacks/**'],
});
```

A placeholder stands only after a fixed first segment: `/*`, `/*/unsubscribe/*` and `/**/x` are refused, because they would cover routes such as
`/login`. Write each locale out (`/de/abmelden/*`, `/en/unsubscribe/*`). A `*` covers every value of its segment, slugs that users choose
themselves included, so `/w/*/unsubscribe` leaves `/w/a/b/unsubscribe` protected but not `/w/anything/unsubscribe`. The path is compared as
the request carries it, with the query string left out and an encoded slash (`%2F`) not counting as a separator.

> [!WARNING]
> An excluded route accepts requests from anywhere. Check each request yourself, and never exclude a route that acts on the
> signed-in user's session. A signature is checked by `verifyWebhook()`, not by an exclusion.

A service provider can add paths the same way: `container.make(CsrfProtection).except('/webhooks/*')`, with `CsrfProtection`
from `@marmeon/session`.

## A link in a mail that posts

A mail client that offers an "Unsubscribe" button posts to the link in the mail's `List-Unsubscribe` header, with no cookie and
no `Origin` (RFC 8058, "one-click"). No pattern in `csrfExcept` should open that route, because a pattern cannot tell the mail's
link from any other path under it. Let the route say that a valid signature is enough:

```ts title="modules/notifications/routes.ts"
import { defineRoutes, everyone, signed } from '@marmeon/http';
import { ConfirmUnsubscribeController } from './controllers/ConfirmUnsubscribeController.ts';
import { UnsubscribeController } from './controllers/UnsubscribeController.ts';

export default defineRoutes((Route) => {
  const leave = Route.prefix('/unsubscribe').authorize(everyone);
  // The page behind the link in the mail's text: it only asks, and posts the same address.
  leave.middleware(signed({ forever: true })).get('/:user', ConfirmUnsubscribeController).name('unsubscribe.confirm');
  leave.middleware(signed({ forever: true, withoutCsrf: true })).post('/:user', UnsubscribeController).name('unsubscribe');
});
```

The CSRF check verifies the signature itself, before it asks for a token, and leaves the request out only if the signature is
valid right now: the path, every query parameter, the expiry and the key are the ones the link was made with. Without a valid
signature the check runs as usual, and the answer is a 419 (or a 403 from a foreign `Origin`), then `signed()`'s own 403. A signed
link of another route, or of the same route with other parameters, opens nothing, and a route without `withoutCsrf` stays protected
even for a valid signature. `GET` and `HEAD` are as before.

> [!WARNING]
> The CSRF check is off for every request that carries the link, whoever sends it and with whichever cookies, and the signature covers
> the path and the query, not the body. Act only on what the link names, never on the session's user or the body, and give the route
> only the work the mail's reader may do: leaving a list, not signing in or changing an account. This matters most with
> `SESSION_SAME_SITE=none`; the default `lax` sends no session with a cross-site form post.

A mail client posts, but the reader who clicks the link in the mail's text sends a `GET` to the same address. The signature does not
cover the method, so the `GET` route shows a page whose form posts to that address, and changes nothing itself: a scanner or a
prefetch that opens every link of a mail would otherwise unsubscribe everyone. Send that page with `Cache-Control: no-store, private`,
`Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, since its address is a credential. Make the link with
`foreverSignedRoute()` when it must work as long as the mail exists, and put it in the mail's headers and in its text (see
[Mail](mail.md#leaving-a-list-with-one-click)).

## Plain HTTP

Browsers send Fetch Metadata to secure origins only: `https://` addresses, `localhost` and `127.0.0.1`. A server reached over
plain HTTP, such as a staging host without TLS, falls back to the `Origin` header. Every current browser sends it with a form's
post and with `fetch`, so your forms keep working. Serve production over HTTPS all the same: the session cookie travels in plain
text otherwise.

## Clients without a browser

A script or a mobile app that posts to `web` routes sends either the token of its session or an `Origin` your app accepts. Routes
for such clients usually belong in a module's `apiRoutes` file instead. The `api` group has no session and no CSRF check, since
every request proves itself with its token. The [API tokens](api-tokens.md) page explains them.

## Live validation, uploads and islands

A live validation is the form's own request with a header that asks to check some fields, so it is checked like the submit. The
request that asks for an upload's target is a request of the form's route, too. Islands and live streams only read, so they pass
without a check.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CSRF_TRUSTED_ORIGINS` | empty | Other origins that may post to the app, comma-separated. Your own origin and `APP_URL`'s always may. |
| `APP_URL` | none | Its origin always passes the check. |

## Testing

`createTestApp` turns the check off, so a test can post without headers or a token, unless the test app runs as production
(`env: { NODE_ENV: 'production' }`), where it stays on as on a server. Nothing else switches it off, and a `csrfExcept` pattern
that does not start with a fixed segment (`*`, `/*`) throws. Pass `csrf: true` to test the check itself,
and send what a browser sends:

```ts title="modules/notes/csrf.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', csrf: true });
});

it('refuses a note posted from another site', async () => {
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).post('/notes', { form: { title: 'Hi' }, headers: { 'sec-fetch-site': 'cross-site' } }).assertForbidden();
});
```

The [HTTP tests](http-tests.md) page covers requests and their assertions.
