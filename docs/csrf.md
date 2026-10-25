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
cannot carry a token, come from no browser and carry no signature either, a module lists the paths in `csrfExcept`. A `*` matches any characters, and the pattern covers the whole path:

```ts title="modules/billing/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'billing',
  routes,
  csrfExcept: ['/webhooks/*'],
});
```

> [!WARNING]
> An excluded route accepts requests from anywhere. Check each request yourself, and never exclude a route that acts on the
> signed-in user's session. A signature is checked by `verifyWebhook()`, not by an exclusion.

A service provider can add paths the same way: `container.make(CsrfProtection).except('/webhooks/*')`, with `CsrfProtection`
from `@marmeon/session`.

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

`createTestApp` turns the check off, so a test can post without headers or a token. Pass `csrf: true` to test the check itself,
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
