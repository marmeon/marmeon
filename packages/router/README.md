# @marmeon/router

Routes, invokable controllers with their request definitions (REPR), route model binding, middleware groups and the
pipeline, typed query strings, URL generation, request input and cookies — the router that
[@marmeon/http](../http/README.md) registers and the server kernel dispatches to (Hono matches the URL, this package runs
the route). It knows no container, no database and no validation library: classes are built through a resolver, records come
from binders, schemas are [Standard Schema](https://standardschema.dev) (Valibot in the docs and generators, E5).

```ts
// modules/user-profile/routes.ts — `routes` in defineModule({ … })
export default defineRoutes((Route) => {
  // Filtered and sorted by the query string (`ListPeopleRequest`) — state that lives in the URL.
  Route.middleware(authenticate()).get('/people', ListPeopleController).name('user-profile.people');

  const users = Route.prefix('/users').middleware(authenticate()).name('user-profile.');
  users.get('/me', RedirectToOwnProfileController).name('me');
  const user = users.bind('user', UserRepository);                       // ctx.params.user: the row, or a 404
  user.get('/:user/edit', EditUserProfileController).name('edit');
  user.put('/:user', UpdateUserProfileController).name('update');
  // A link is looked up *within* its user: another user's link id under this user is a 404 (no IDOR).
  const link = user.bind('link', ProfileLinkRepository, { scopedBy: 'user' });
  link.delete('/:user/links/:link', DeleteProfileLinkController).name('links.destroy');
});
```

Apps import the everyday names from `@marmeon/http`, which re-exports them: `defineRoutes`, `defineRequest`,
`defineMiddleware`, `Router`, `ValidationError`, `translatable`, `abort`, `HttpError` and the types `HttpContext`, `ContextOf`,
`FormOf`, `QueryOf`, `Next`, `MiddlewareClass`, `RouteBinder`, `RouteName`, `Routes` … Import from `@marmeon/router` what it
does not re-export (`MiddlewarePriority`, `GLOBAL`, `parseQuery`, `urlFor`).

## Registration

The package has no `"marmeon"` field and no provider of its own — it is a library. `HttpServiceProvider` of
`@marmeon/http` (found by `marmeon discover`) registers the `Router` as a singleton, sets up the `web` and `api` groups and
loads every module's routes:

| `defineModule({ … })` | Group | Prefix |
| --- | --- | --- |
| `routes` | `web` — encrypted cookies, the session, CSRF, the asset version (the packages add them, see [Middleware](#middleware)) | none |
| `apiRoutes` | `api` — stateless: no cookies, no session (API tokens) | `/api` |

Two entry points:

| Import | Runs in | What |
| --- | --- | --- |
| `@marmeon/router` | server | everything below |
| `@marmeon/router/url` | server **and** browser | `urlFor`, `fillPath`, `toSearchParams`, `matchesPath` — no imports at all; the browser gets them through `@marmeon/http/page` |

## Configuration

No config class and no environment variable of its own. What shapes it:

- **App middleware** — `defineApplication({ middleware: { global, web, api } })`, appended after the framework's own (priority
  `app`, see [Groups and priorities](#groups-and-priorities)).
- **What the browser may learn** — `defineApplication({ clientRoutes: { include, except } })`: by default the named `web`
  routes, API routes only when listed in `include`, `except` wins over both (`*` matches anything: `except: ['admin.*']`),
  `.internal()` routes never. Of these, a client build ships only the names its code writes out (E57, see
  [@marmeon/vite](../vite/README.md#the-route-manifest-e57)). The server knows every route either way.
- **Request bodies and addresses** — `MAX_BODY_SIZE` (default `8m`; bytes or `512k`, `8m`, `1g`) and `TRUSTED_PROXIES`
  (addresses or CIDR ranges, comma-separated, or `*`) of [@marmeon/server](../server/README.md#configuration)'s
  `ServerConfig`; the kernel hands them to `createRequestState` (`maxBodySize`, `ip`), with the request's `RequestNonce` and the
  cookie defaults (`cookies: CookieDefaults`, E162). Without a server, `DEFAULT_MAX_BODY_SIZE` (8 MiB) applies.

## Routes

```ts
export default defineRoutes((Route) => {
  Route.get('/', ShowHomeController).name('home');
  Route.post('/locale', UpdateLocaleController).name('locale.update');
  Route.get('/health', () => ({ ok: true }));                 // a closure: strings become HTML, objects JSON, nothing 204
});
```

- **Methods:** `get` (HEAD too), `post`, `put`, `patch`, `delete`, `options`, `match(['GET', 'POST'], …)`, `any(…)`.
- **Parameters** are typed from the path: `/teams/:team/users/:id?` → `{ team: string; id?: string }`; a constraint goes in
  braces, `/:id{[0-9]+}`.
- **Groups:** every attribute call returns a new registrar, so the context type and the parameters flow into what is
  registered through it — `prefix('/teams/:team')`, `name('teams.')`, `middleware(m)`, `bind(…)`, `internal()`, and
  `group((Route) => { … })` to write them once for a block.
- **Names** are an API (redirects, links, `<Link route>`): a name used twice is a boot error naming both routes.
  `name('show')` in `name('profile.')` is `profile.show`.
- **`.internal()`** — on a route or a registrar — keeps a route out of the browser for good: `marmeon route:types` marks it
  `browser: false`, naming it in client code is a compile error, and it never enters the browser's manifest. For links only
  the server builds, like the signed verification link it mails:
  `signedIn.middleware(signed()).get('/email/verify/:id/:hash', VerifyEmailController).name('auth.verification.verify').internal()`.
- **`.block(lockSeconds = 10, waitSeconds = lockSeconds)`** — on a route — runs its requests one at a time per session (Laravel's
  `block()`, E145): `StartSession` of [@marmeon/session](../session/README.md#blocking-routes-block) holds the session's lock
  (through the cache) from before it reads the session until it saved it; a request that waits longer answers 423.
  `RouteDefinition.blocking` says what a route asked for.
- **What the types refuse** (and the router at boot, for code they did not check): a GET route whose controller validates a
  body (E65: validate its URL with `query`), a route of another method whose controller answers `this.island(…)` (E52:
  islands only read), a `bind('user', …)` without a `:user` in the path.
- **`marmeon route:types`** writes `bootstrap/routes.ts` — `declare module '@marmeon/router' { interface Routes { … } }`
  with each route's method, path and controller — which types every API that takes a route name: `router.url()`,
  `this.redirect().route()`, signed URLs, `<Link route>`, `useForm(name, …)`. `marmeon dev` and `marmeon build` run it; CI checks
  it with `--check`. It reads the routes of an app that registered and booted nothing (E187: no `.env`, no key needed) — a module's
  `routes` are loaded while the http provider registers; routes a provider loads in `boot()` are not in it. `marmeon route:list` prints method, path, name, group, middleware (in the order they run) and action.

## Controllers and requests

One invokable class per endpoint: `handle(ctx)`, constructor arguments from the container (per request). What it accepts
and who may call it is declared next to it with `defineRequest` and attached as `static request` (E13):

```ts
// modules/user-profile/controllers/UpdateUserProfileController.ts
export const UpdateUserProfileRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string(), v.trim(), v.minLength(2, trans('user-profile.validation.name_min')), v.maxLength(60)),
    bio: v.pipe(v.string(), v.trim(), v.maxLength(200, trans('user-profile.validation.bio_max'))),
  }),
  // Only your own profile. Runs after binding, before validation — others get a 403, not field errors.
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class UpdateUserProfileController extends Controller {
  static request = UpdateUserProfileRequest;

  constructor(users: UserRepository) { … }

  async handle(ctx: ContextOf<typeof UpdateUserProfileRequest>) {
    await this.#users.update(ctx.params.user.id, ctx.body);     // ctx.body: { name: string; bio: string } — validated, trimmed
    …
  }
}
```

A request runs in this order, and the controller is built only when everything before it passed:

1. global, group and route middleware (authentication answers before a 404 could tell what exists);
2. route bindings — a missing record is a 404;
3. `authorize(ctx, resolve)` — `false` is a 403 (or it throws its own `HttpError`); `resolve` builds classes from the request's
   scope, which is how `can(Policy, …)` of [@marmeon/auth](../auth/README.md#authorization-policies-and-the-gate-e28) gets its
   policy (E28);
4. the query, parsed by `query` — never fails (see [Query schemas](#query-schemas-e55-e56));
5. the body, validated by `schema` — a 422 `ValidationError` with the errors per field (`address.city` for nested ones);
6. `handle(ctx)` with `ctx.body` (the schema's output) and `ctx.query` (the parsed query).

- **`schema`** sees the body only, never the query (E65). It may be a function of `resolve`, built per request, for rules
  that need the app: `schema: (resolve) => v.objectAsync({ email: v.pipeAsync(…, v.checkAsync((email) => resolve(UserRepository)…)) })`
  — such a rule runs on submit and in a live validation of its field alike.
- **Types:** `ContextOf<typeof Request>` is what `authorize` needs plus `body` and the parsed `query`;
  `FormOf<typeof Controller>` the schema's *input* (what a form sends — `useForm(name)` types its fields with it),
  `QueryOf<typeof Controller>` the parsed query. `handle`'s context is checked against what the route provides: a controller
  that needs `ctx.user` on a route without the authentication middleware is a compile error.
- **Messages** may be translation keys: `translatable(key, params, fallback)` (apps use the typed `trans()` of
  [@marmeon/i18n](../i18n/README.md)) leaves the key on the issue, and the exception handler shows it in the request's language
  (`ValidationError.translate`). Such a message may name its field — `{attribute}`: the path with underscores as spaces
  (`password_confirmation` → "password confirmation"), Laravel's rule.
- **`messages` and `attributes`** — Laravel's `messages()` and `attributes()` of a form request, for the framework's rules
  ([@marmeon/validation](../validation/README.md#messages)): `messages: { 'email.unique': 'profile.validation.email_taken', required:
  'Fill this in.' }` (`<field>.<rule>` or `<rule>`), `attributes: { email: 'profile.fields.email', 'links.*.url': 'link' }` (`*` is one
  segment). Values are translation keys or texts.
- **Any Standard Schema library** — `rules` of [@marmeon/validation](../validation/README.md) (what docs and generators use, E197),
  Valibot, Zod, ArkType. The interface is `@marmeon/core`'s (the router re-exports its types). `validateRequest` hands every schema
  `libraryOptions: { marmeon: { resolve, ctx, live } }` (`ValidationContext`) — how `unique()` gets its repository without a
  `schema: (resolve) => …` factory; other libraries ignore it.
- The base class `Controller` (`this.view()`, `this.json()`, `this.redirect()`, `this.island()`, `this.closeLayer()`) and what a
  result becomes are [@marmeon/http](../http/README.md)'s.

## Query schemas (E55, E56)

A GET has no body: its controller reads the URL, typed by `query`. Links outlive their pages and people type URLs, so a
query **never answers 422** — an invalid field falls back to its default:

```ts
export const ListPeopleRequest = defineRequest({
  query: v.object({
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60)), ''),
    sort: v.optional(v.picklist(PEOPLE_SORTS), 'name'),
    ...pageQuery({ perPage: [10, 25, 50] }),   // @marmeon/database: ?page= and ?per_page=, for paginate(…, ctx.query) and <Pagination>
  }),
});
// handle(ctx: ContextOf<typeof ListPeopleRequest>) — ctx.query: { q: string; sort: 'name' | '-name' | …; page: number; per_page: 10 | 25 | 50 }
```

- **The schema must be total** — an empty query must be valid — and the types say so in the expected type: every field
  optional or with a default (`query fields need a default or must be optional: 'page' is required`), string input (`parse
  the string, e.g. v.pipe(v.string(), v.toNumber())`), and an output that can go back into a URL (a string, number, boolean
  or a list of them).
- **Parsing** (`parseQuery`): a field the schema rejects is taken out and the rest validated again, so it gets its default;
  one value where the schema wants a list is tried as a list of one (`?tag=a`), a repeated key is a list (`?tag=a&tag=b`) —
  what `toSearchParams` writes for a list, and what the browser sends for a list in a GET's `data` (`reload({ data: { tag:
  ['a', 'b'] } })`, since Wave 9; before, `?tag=a%2Cb`); unknown keys are ignored; `__proto__` is no key. `/people?sort=DROP
  TABLE` is the list by name, 200. A schema that **throws** instead of reporting an issue stops the request with its error —
  what the keys of a server-driven table do on purpose ([@marmeon/table](../table/README.md#the-url--strict-on-purpose):
  an unknown sort, filter or page size is a 400, W9).
- **`queryOptions: { onInvalid: 'redirect' }`**: a GET with an invalid or unknown field is answered `302` to its canonical
  URL — only the valid fields that differ from their defaults — so the address bar shows what the page shows. Other methods
  always fall back. Default `'fallback'`.
- **The page object** gets the parsed query without defaults (`PageObject.query`) and the defaults (`queryDefaults`): the
  browser never parses a URL (`useQueryState`, `<Link query>` — see [@marmeon/http](../http/README.md#the-protocol)).
- Without a query schema, `ctx.query` stays the raw `URLSearchParams`.

## Route model binding

`Route.bind(param, Binder)` resolves a path parameter before `authorize` runs, so the controller (and `authorize`) get the
record; a binder that finds nothing answers 404:

```ts
users.bind('user', ProfileDirectory).get('/:user', ShowUserProfileController).name('show');
// handle(ctx: HttpContext<Authenticated, { user: Profile }>) — a missing user never gets here
```

- **A binder** is any injectable class with `resolveRouteBinding(value, { ctx, scope })` (`RouteBinder<T>`), built per request.
  Repositories of [@marmeon/database](../database/README.md) are binders: the row whose `routeKey` (default `id`, digits
  only — `routeKeyPattern` for another) is the value. A repository's `static table` must match the table it is typed for.
- **Scoped** (`{ scopedBy: 'team', column?: 'team_id' }`): the child is looked up *within* its already resolved parent
  (`column` defaults to `<parent>_id`) — another parent's id is a 404, so an insecure direct object reference cannot happen by
  forgetting a check.
- An absent optional parameter stays absent. Bindings run in the order they were declared.

## Middleware

```ts
const authenticate = defineMiddleware<{ user: User }>('auth', async (ctx, next) => {
  const user = await findUser(ctx.request);
  return user ? next({ user }) : new Response('Unauthorized', { status: 401 });
});
// Needs `user` from an earlier middleware, adds nothing:
const requireAdmin = defineMiddleware<EmptyObject, { user: User }>('admin', (ctx, next) =>
  ctx.user.isAdmin ? next() : new Response('Forbidden', { status: 403 }),
);
```

- **What `next({ … })` passes** becomes part of the context of everything after it — typed: `Route.middleware(authenticate)`
  makes `ctx.user` exist for the routes registered through that registrar, and middleware whose requirements are unmet does
  not compile. Contexts are copied, never mutated.
- **Classes** — `handle(ctx, next)` and an optional `terminate(ctx, response)` that runs after the response was handed off
  (errors are logged, never sent) — are built per request from the container, with constructor injection. Calling `next()`
  twice rejects.
- **Errors** become a response at the layer that threw (the kernel's exception handler), so outer middleware — security
  headers, the session, cookies — still applies to error pages.

### Adding headers to the response — `editableResponse`

A middleware that adds a header takes the response through `editableResponse` (also exported by @marmeon/http):

```ts
export class SecurityHeaders {
  async handle(ctx: HttpContext, next: Next<{}>) {
    const response = editableResponse(await next());
    response.headers.set('x-frame-options', 'DENY');
    return response;
  }
}
```

It hands back the response itself when the request owns it — the framework made it for this request (a page, a document, a
redirect, a region, an error page, a `this.json(…)`) or copied it once already — and otherwise a copy the request owns from then
on. So a request copies its response at most once, however many middleware add headers (the cookies, the language, the security
headers, the CSP, `no-store`, the request id); before Wave 8 step 9 each of them copied it — four or five copies per page, about
2.5 µs each. A `Response` that an action or a middleware returns itself is never changed in place: an app may hand out the same
object to every request (a constant `new Response(null, { status: 204 })`) — a cookie set on it would reach the next request —
and its headers may be immutable (`Response.redirect()`, `fetch()`). `ownResponse(response)` marks a response a package builds
per request as owned; never one that could be handed out twice. Copying the response yourself
(`new Response(response.body, response)`) still works — it costs the copy.

### Groups and priorities

A route runs the global stack, then its group's (`web` or `api`), then its own middleware; one listed twice runs once, at its
first place. Requests no route matched pass the global stack and then end in a 404. Packages append to groups while booting
(`router.middleware.append(group, middleware, priority)`), in any order — the priority decides where it runs (lower first,
equal ones in the order added). A group's list is sorted once and frozen, and `router.middlewareFor(route)` — the global stack,
the group's, the route's, each once — is worked out once per route; an `append` or `remove` starts both over (Wave 8 step 9: they
were sorted on every request):

| `MiddlewarePriority` | | Middleware (package) |
| --- | --- | --- |
| `encryptCookies` | 100 | `EncryptCookies` (http) |
| `clearClientHistory` | 150 | `ClearClientHistory` (http) |
| `startSession` | 200 | `StartSession` ([session](../session/README.md)) |
| `preventCaching` | 210 | `NoStoreWhenSignedIn` ([auth](../auth/README.md#signed-in-answers-are-never-cached)) |
| `setLocale` | 220 | `SetLocale` ([i18n](../i18n/README.md#the-requests-locale-setlocale)) |
| `checkAssetVersion` | 250 | `CheckAssetVersion` (http) |
| `verifyCsrfToken` | 300 | `VerifyCsrfToken` (session) |
| `shareProps` | 400 | `ShareErrorsFromSession` (session) |
| `app` | 1000 | the app's own (`defineApplication({ middleware })`, the default) |
| `limitLiveValidation` | 1100 | `LimitLiveValidation` ([cache](../cache/README.md)) — the last of the **global** stack |

The rest are in `web`. `GLOBAL` (`'global'`) names the global stack. Rate limits are middleware of
[@marmeon/cache](../cache/README.md) — `Route.middleware(throttle('register')).post(…)` with a limiter defined by
`RateLimiter.for(…)`; `signed()` (a valid, unexpired signature or 403) is [@marmeon/http](../http/README.md)'s.

## Live validation (E62)

A form's own request — same method, URL and body — with `x-marmeon-validate: name,email` runs the route as far as its
validation: middleware (CSRF, authentication, throttling), bindings, `authorize` and the request schema. Its controller is
never built. The answer is `204`, or `422` with the named fields' errors only — both with `x-marmeon-validated: name,email`
and `no-store`. Issues of fields not named are dropped (they are not filled in yet), and so are issues of the whole body — and
those of rules that are not live (`NOT_LIVE` on the issue: `unique`, `exists` and async rules of
[@marmeon/validation](../validation/README.md#database-rules-and-live-validation) unless they say `.live()`, E197). Those rules do
not even run in a live validation; the filter catches one that ran anyway (inside another library's schema).

- Field names are paths (`email`, `address.city`, `links.0.url`), at most 64 per request; unusable ones are left out. A
  request with the header is a live validation even with none left — never a submit.
- A route without a body schema (a GET, a closure, no `schema`) has nothing to check: 400.
- `throttle(name)` holds a live validation to the route's limit without counting it; live validations have their own limit
  (`LimitLiveValidation`, 30 a minute per route and address). The kernel makes the request read-only.
- `isLiveValidation(request)` and `liveValidationFields(request)` tell one apart; the client side is in
  [the protocol](../http/README.md#the-protocol).

## URLs

```ts
constructor(router: Router) { … }
this.#router.url('user-profile.show', { user: 7 }, { tab: 'links' });   // → /users/7?tab=links
```

Names, parameters and the query are checked against the generated `Routes`: a wrong name is a compile error with
"did you mean" (`'user-profile.shwo' is not a route name — did you mean user-profile.show, …?`), required parameters are
required, and the query of a route with a query schema is typed by its fields (`page: 2`, not `'2'`). Parameters the path
does not take go into the query string, like Laravel. Values are percent-encoded; `null` and `undefined` are left out, a
list repeats its key.

`urlFor(lookup, name, params, query)` is the one code path behind `router.url()`, signed URLs and the browser's `route()` —
any `{ findByName }` works, the router or the browser's manifest. Signed URLs (`UrlSigner.signedRoute`,
`temporarySignedRoute`, `signedPath`) are [@marmeon/http](../http/README.md)'s.

## Request input and cookies

Every context has the raw `request`, its `route`, `params` and:

- **`ctx.input()`** — the body, and only the body (E65): unlike Laravel's `$request->all()`, the query is never merged in, so
  no field can be set through a link. JSON (an object), `application/x-www-form-urlencoded` and `multipart/form-data` (files
  are `File`s; an empty file field is skipped) are parsed alike; bracket notation nests (`user[name]`, `tags[]`,
  `links[0][url]`; at most 20 levels; `__proto__` is dropped; objects with keys `0…n-1` become arrays). Parsed once and
  cached — do not read `ctx.request` yourself after it. A GET or HEAD has `{}`. Bodies over the limit are a 413 (counted,
  whatever `Content-Length` says), malformed JSON a 400.
- **`ctx.query`** — the `URLSearchParams`, or the parsed query behind a query schema.
- **`ctx.ip`** — the client's address: the right-most `X-Forwarded-For` entry that is not a trusted proxy (`clientIp`; the
  server's `TRUSTED_PROXIES` with ranges, [@marmeon/server](../server/README.md#behind-a-proxy-e162)).
- **`ctx.nonce()`** — the response's CSP nonce (E147): made on the first call, the same for the whole response — for HTML a
  controller writes itself under `contentSecurityPolicy()` ([@marmeon/http](../http/README.md#content-security-policy-e147)).
- **`ctx.expectsJson()`** — JSON is the first accepted type, or an XHR that accepts anything (Laravel's).
- **`ctx.cookies`** — a `CookieJar`: `get`, `has`, `all` read what the client sent; `set(name, value, options)` and
  `delete(name, { path, domain })` queue cookies for whatever response the request ends with — a view, a redirect or an
  error page. Defaults: `Path=/`, `HttpOnly`, `SameSite=Lax`, a session cookie, `Secure` as the jar's defaults say (with
  `@marmeon/session`: `SESSION_SECURE_COOKIE`, which follows `APP_URL`, E162 — `secure: false` opts out); `sameSite:
  'none'` requires `secure`. In the
  `web` group `EncryptCookies` installs a codec, so values are encrypted on the wire; read-only requests (an island) lock the
  jar, and a `set` there is refused.

## Errors

- **`abort(404)`**, `abort(403, 'Not yours.')` — throws an `HttpError(status, message?, headers?, translation?)`. Its message
  is meant for the client; without one, the status text and the key `marmeon.status.<status>` (translated when a translator
  is bound). Controllers and middleware alike may throw it.
- **`ValidationError`** (422): `errors` (`{ field: [messages] }`), `input` (for the old input), `issues`, `labels` (the request's
  `messages`/`attributes`); `ValidationError.fromIssues(issues, input, labels?)`; the message is the first error plus a count.
  `messageOf(issue, { translator, labels })` is the text of one issue.
- `statusText(404)` → `Not Found`. How errors are rendered (pages, JSON, the development error page) is the exception handler's,
  in [@marmeon/http](../http/README.md) and [@marmeon/server](../server/README.md#error-page-e119--development-only).

## For packages

- `router.beforeValidation(hook)` — runs before every body schema (after `authorize`; a submit and a live validation alike)
  and may replace input values: `@marmeon/storage` puts a verified upload in place of its token.
- `router.intercept({ claims, answer })` — answers requests it claims in the route's place, after the route's middleware,
  bindings and `authorize`; the controller is never built. Upload targets (`x-marmeon-upload`) are answered this way.
- `router.load({ group, prefix }, ...definitions)` — loads route files into a group (what the http provider does per module).

## Testing

`createTestApp` of [@marmeon/testing](../testing/README.md#requests) sends requests through the whole kernel:

```ts
const app = await createTestApp(application, { database: 'refresh', seed: true });
await app.actingAs(ada).get('/people?sort=nope').assertOk().assertPage('user-profile/People');      // E56: never a 422
await app.validating('name', 'email').post('/register', { json: registration }).assertLiveValid('name', 'email');
await app.actingAs(alan).expectingJson().put(`/users/${ada.id}`, { json: { name: 'Mallory', bio: '' } }).assertForbidden();
```

`assertInvalid<UpdateUserProfileController>({ name: /short/ })`, `assertNotFound()`, `assertRedirect('/login')` and
`assertPage<C>(name, props)` check what came back.
