# HTTP Tests

## Introduction

An HTTP test sends a request to your app and checks the response. The request runs through the whole kernel, middleware and
session included, and the assertions chain onto it:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('creates a note and shows it', async () => {
  const ada = await app.factory(UserFactory).create();
  await app
    .actingAs(ada)
    .post('/notes', { form: { title: 'Groceries', body: 'Milk' } })
    .assertRedirect()
    .assertFlashed('toast', { message: 'Note saved.' });
  await app.assertDatabaseHas('notes', { user_id: ada.id, title: 'Groceries' });
});
```

The [getting started](testing.md#creating-the-test-app) page explains `createTestApp()` and the test environment.

## Making requests

`app.get()`, `app.post()`, `app.put()`, `app.patch()` and `app.delete()` take a path and options. `app.request(method, path,
options)` sends any other method. The options say what the request carries:

| Option | What it sends |
| --- | --- |
| `headers` | Request headers: `{ 'accept-language': 'de' }`. |
| `form` | A body as an HTML form sends it, `application/x-www-form-urlencoded`. An array repeats the field. |
| `multipart` | A `multipart/form-data` body, with `File` and `Blob` values. |
| `json` | A JSON body, with `Content-Type: application/json`. |
| `body` | A body exactly as given: bytes, a string or a stream. |

A request without an `Accept` header is answered like a browser's page load: a page answers with its HTML document. An error,
though, gets the error page only when the request accepts `text/html` or is a client-side visit, and JSON otherwise. Send
`headers: { accept: 'text/html' }` to get exactly what a browser gets. The [testing pages](testing-pages.md#asserting-a-page) page
shows how to ask for the page object instead.

A request does not run until you `await` it. The assertions chained onto it run then, in order, and the awaited value is the
response. Every request also waits for the work the app does after its response, such as `terminate` hooks and
`afterResponse.defer()`, so a test sees what that work wrote:

```ts
const response = await app.actingAs(ada).post('/notes', { json: { title: 'Groceries', body: '' } }).assertRedirect();
const location = response.headers.get('location');
```

### Reading the response

The awaited response holds:

| Member | What it is |
| --- | --- |
| `status`, `headers`, `body` | The status, the `Headers`, and the body as text. |
| `bytes()` | The body as a `Uint8Array`, for a binary answer such as an image or a PDF (`body` decodes the same bytes as UTF-8). Each call returns a copy. |
| `json()` | The body parsed as JSON. |
| `page()` | The page object of a page answer, from a client visit's JSON or the document's page script. |
| `cookie(name)` | A cookie the response set, decrypted as the app reads it. For the session cookie, which the app sends only when the session is new or its id changed, it is what the browser holds after the response: the request's cookie when the response sends none. |
| `session()` | The session after the request, read from the store through the session cookie the response sent, else through the one the request came with (when the app accepted it). `assertCookie()` and `assertCookieMissing()` check only what the response sent. |
| `flash()`, `flashed()` | The flash messages this response delivers, and those waiting in the session. |

## Request defaults

The methods below return a new view of the same app, with defaults for every request sent through it. The view shares the app,
its database and its fakes, so you can keep one per user:

| Method | What it adds |
| --- | --- |
| `withHeaders(headers)` | Headers on every request. |
| `expectingJson()` | `Accept: application/json`, as an API client sends it. |
| `withIp(address)` | The client address the request comes from, as a socket's peer: `ctx.ip` holds it, and `SERVER_TRUSTED_PROXIES` applies. Without it `ctx.ip` is undefined. |
| `withCookie(name, value)` | A cookie, encrypted as the app encrypts its own. |
| `withUnencryptedCookie(name, value)` | A cookie exactly as given, to prove that a forged value is ignored. |
| `withSession(data)` | A session that holds `data` before the request. |
| `actingAs(user)` | A session signed in as `user`, as a sign-in leaves it. |
| `actingAs(user, { guard: 'api', abilities })` | A real API token of `user` in the `Authorization` header. |

`expectingJson()` changes what a failure looks like: a guest gets `401` instead of a redirect to the sign-in page, and invalid
input a `422` with the errors instead of a redirect back.

## Sessions and signing in

`actingAs(user)` writes a session as a sign-in leaves it and sends its cookie. `withSession(data)` writes a session that holds
`data`. Both use the session driver `.env.test` sets with `SESSION_DRIVER=memory`.

A view made by `actingAs()` or `withSession()` keeps one session id across its requests, like one browser. The session is stored
as the app stores its own: under the hash of its id, and encrypted when the app encrypts its sessions. To go on with the session
a response started, such as a real sign-in, send its cookie back:

```ts title="modules/notes/sign-in.test.ts"
import { SessionConfig, sessionCookieName } from '@marmeon/session';
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('signs in with the password and keeps the session', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const login = await app
    .post('/login', { form: { email: ada.email, password: 'password' } })
    .assertRedirect('/dashboard')
    .assertAuthenticated(ada);
  const session = sessionCookieName(app.container.make(SessionConfig)); // `__Host-…` when APP_URL is https
  const browser = app.withCookie(session, login.cookie(session)!);
  await browser.get('/dashboard').assertOk();
  await browser.post('/logout').assertRedirect('/login').assertGuest();
});
```

`UserFactory` gives every user the password `password`. `actingAs(user, { guard: 'api', abilities: ['notes:read'] })` creates a
real API token with those abilities and sends it as `Authorization: Bearer …`, without a session. Without `abilities` the token
may do everything. The [API tokens](api-tokens.md#testing) page shows a test.

## CSRF protection in tests

A test app does not check requests for CSRF, so a test can post without a token. `createTestApp(application, { csrf: true })`
turns the check on. A test request sends neither `Sec-Fetch-Site` nor `Origin` by itself, so send what a browser sends, such as
`headers: { 'sec-fetch-site': 'same-origin' }`, or the session's token. The [CSRF protection](csrf.md#testing) page shows a test.

## Requests of the browser's client

In the browser, the app's client sends more than page loads: client-side visits, partial reloads, islands, layers, actions and
live validation, each marked by its own headers. A view sends a request the way the client would:

| Method | The request it sends |
| --- | --- |
| `navigating()` | A client-side visit, answered with the page object as JSON. |
| `prefetching()` | A prefetch of a link, marked `Purpose: prefetch`. |
| `reloading<Controller>(component, { only, except })` | A partial reload of the page on screen. |
| `islanding()`, `island(name, params, query)` | The request of an island. `island()` takes the route's name. |
| `layering()`, `layer(name, params, query)` | The request of a layer. `layer()` opens one by the route's name. |
| `acting()` | An action, as `useAction()` sends it. |
| `validating(...fields)` | A live validation of those fields. The controller never runs. |

Every one of these sends `x-marmeon: 1`, the version of the page protocol (`PROTOCOL_VERSION` in `@marmeon/http/protocol`). A
request of the client that names another version, or none, gets `409` before any middleware or controller runs, so a test that sets
`x-marmeon: 'true'` or only `x-marmeon-action` by hand gets that answer: use the helpers, or send `PROTOCOL_VERSION`. The
refusal itself is tested the other way round:

```ts
await app.withHeaders({ 'x-marmeon': '0' }).post('/notes', { json: { title: 'Hi' } }).assertStatus(409).assertHeader('x-marmeon-reload', 'version');
```

A client-side visit across the sign-in boundary gets the protocol's full reload, a `409` with the target in
`x-marmeon-location`:

```ts title="modules/notes/sign-out.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('loads the sign-in page fully after signing out', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).navigating().post('/logout').assertStatus(409).assertHeader('x-marmeon-location', '/login').assertGuest();
});
```

The [testing pages](testing-pages.md) page covers pages, partial reloads, islands, layers and actions.

### Live validation

`validating(...fields)` sends the form's request the way live validation does. The app validates the named fields and answers
`204`, or `422` with their errors. The controller never runs:

```ts
await app.actingAs(ada).validating('title').post('/notes', { json: { title: '' } }).assertInvalid(['title']);
await app.actingAs(ada).validating('title').post('/notes', { json: { title: 'Groceries' } }).assertLiveValid('title');
```

`assertLiveValid(...fields)` checks the `204` and that the app checked those fields. The
[validation](validation.md#live-validation) page explains live validation.

## Uploads

`app.upload(routeName, field, file, params)` sends a file the way the browser does: it asks the route's upload target, sends the
bytes, and resolves with the token the form then sends in the field. The upload belongs to the view's session, so send the form
through the same view:

```ts title="modules/notes/cover.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteRepository } from './NoteRepository.ts';

const PNG = Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/ehBVmQAAAABJRU5ErkJggg==');

it('stores a cover for the note', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Groceries', body: '' });
  const browser = app.actingAs(ada);
  const token = await browser.upload('notes.cover.update', 'cover', new File([PNG], 'cover.png', { type: 'image/png' }), { note: note.id });
  await browser.put(`/notes/${note.id}/cover`, { json: { cover: token } }).assertRedirect();
  app.storage.disk('public').assertCount(1, 'covers');
});
```

The route and the field are checked by the compiler. A field without an `upload()` rule does not compile:

```text
Argument of type '"title"' is not assignable to parameter of type '"'title' is no upload field of this form — its upload fields: cover"'.
```

A target the route refuses fails the call with the response's status: `404` without an `upload()` rule, `403` when authorization
fails, `422` for a file that is too large. Uploads land on the [storage fake](fakes.md#storage). The [forms](forms.md#uploads) page
explains uploads.

## Assertions

### Status

| Assertion | Passes for |
| --- | --- |
| `assertStatus(status)` | That status. |
| `assertOk()`, `assertCreated()`, `assertNoContent()` | `200`, `201`, `204`. |
| `assertSuccessful()` | Any `2xx`. |
| `assertUnauthorized()`, `assertForbidden()`, `assertNotFound()`, `assertUnprocessable()` | `401`, `403`, `404`, `422`. |
| `assertRedirect(location)` | Any `3xx`, and with `location` that exact `Location` header. |

### Validation

`assertInvalid(fields)` finds the errors in a `422` answer, or in the session when a form request was redirected back. It takes
the names of the fields, or the messages they must have, each a string or a regular expression:

```ts
await app.actingAs(ada).post('/notes', { form: { title: '' } }).assertRedirect().assertInvalid(['title']);
await app.actingAs(ada).expectingJson().post('/notes', { json: { title: '' } }).assertInvalid<StoreNoteController>({ title: /required/ });
```

With a controller as the type argument, a field the controller's form does not have is a compile error. `assertValid()` passes
when there are no errors in either place.

### Flash messages

A flash message travels in two steps. A redirect leaves it waiting in the session, and the next answer that is shown delivers it:

| Assertion | Passes when |
| --- | --- |
| `assertFlashed(key, data)` | The message waits in the session after this response, such as after a redirect. |
| `assertFlash(key, data)` | This response delivers it: a page, a partial reload, a layer or an action. |
| `assertNoFlash(key)` | This response delivers no message, or none of that key. |

`data` is a part of the message's data, compared deeply. Keys and data are typed by the app's `FlashData`, so a misspelt key does
not compile. The [pages](pages.md#flash-messages) page explains flash messages.

### Session and sign-in

| Assertion | Passes when |
| --- | --- |
| `assertSessionHas(key, value)` | The session holds `key` after the request, with `value` when given, compared deeply. |
| `assertSessionMissing(key)` | The session lacks `key`, or the request kept no session at all. |
| `assertAuthenticated(user)` | The session is signed in, as `user` when given, compared by id. |
| `assertGuest()` | The session is not signed in. |

These read the session the response's cookie points to. When the response sets
no session cookie at all, such as on a route outside the `web` group, `assertSessionHas()`, `assertAuthenticated()` and
`assertGuest()` fail with `Expected the response to carry a session (is StartSession on this route?)`.

### Cookies

`assertCookie(name, value)` passes when the response sets the cookie, with that value when given. Values are compared decrypted.
`assertCookieMissing(name)` passes when the response does not touch the cookie, and `assertCookieExpired(name)` when it deletes
it.

### Headers and body

| Assertion | Passes when |
| --- | --- |
| `assertHeader(name, value)` | The header is there, with that exact value when given. |
| `assertJson(subset)` | The JSON body contains `subset`: other keys of an object may exist, but an array must match element by element. |
| `assertExactJson(value)` | The JSON body equals `value`. |
| `assertSee(text)`, `assertDontSee(text)` | The body contains the text, or does not. |

### When an assertion fails

A failed assertion says what it expected, and shows the request, the status and the start of the body:

```text
AssertionError: Expected status 200, got 404
  GET /notes/9999 → 404
  {"message":"Not Found"}
```

The body helps when a request fails with a status you did not expect. With `debug: true` the body of a 500 carries the exception,
as the [getting started](testing.md#errors-in-tests) page explains.
