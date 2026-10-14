# Upgrading

This page lists every change between one version and the next that an app has to act on: how likely it is to affect your app, what to do, and the way back where there is one. The
[release policy](docs/releases.md#what-a-version-promises) says what a version promises.

## Upgrading to 0.2.0 from 0.1.3

#### High: Every route has to say who may call it

*Likelihood of impact: high — every app with routes that has not stated an access decision.*

The app refuses to start (and `marmeon route:types` and `marmeon build` exit 1) while a route does not say who may call it. The
error is a `RouteAccessError`; it lists each route with its methods, path, name, controller and the file and line that registered it:

```
2 routes do not say who may call them:
  GET  /posts  posts.index  PostController  modules/posts/routes.ts:4
  POST  /posts  posts.store  Closure  modules/posts/routes.ts:5
Say it with one of these:
  - can(Policy, 'ability', 'param') as the request's `authorize`, or on its registrar: Route.authorize(can(…))
  - a check of your own: Route.authorize((ctx) => …) or `authorize` in defineRequest()
  - everyone, last: Route.authorize(everyone) says anyone its middleware lets through may call it — nothing else about it is checked
See docs/authorization.md#every-route-decides.
```

Start the app, then decide each route listed:

- `can(Policy, 'ability', 'param')` wherever the route reaches a record that belongs to someone, as the request's `authorize` or on the registrar: `Route.authorize(can(…))`.
- `everyone` where the route's middleware is the whole decision: `Route.middleware(authenticate()).authorize(everyone)`, or `defineRequest({ authorize: everyone })`.
- A route file that decides once for all its routes: `const Route = Root.authorize(everyone)`. That is the old behaviour, now written down.

A route that is open to `everyone` and loads a record from the URL without `scopedBy` is refused as well. Give it a policy, scope the
binding (`bind('child', Binder, { scopedBy: 'parent' })`), or, for a route that only reads (`GET`/`HEAD`) and whose records are really public,
mark the binding `bind('param', Binder, { public: true })`. A write under `everyone` is never excused by `public`.

With `tableRoutes(…)` under a registrar that only says `everyone`, give every action, bulk action and export its own `.authorize(…)`.

`Router.dispatch` refuses undecided routes and open unscoped bindings too, so tests that dispatch a route need a decision as well.
`FRAMEWORK_ROUTES` is no longer exported from `@marmeon/http` or `@marmeon/router`, and without that marker `load()` throws for any path
under `/_marmeon/`; a package that used it moves its routes to a prefix of its own and decides them like an app does. Routes are registered synchronously now: the root registrar is sealed once the route files have loaded, so a `defineRoutes(async …)`
callback, or a registrar kept and used after loading, fails at load. Move the `await` out of the route file.
A request's `authorize` that returns a truthy value other than `true` (possible from untyped code
only) now answers 403.

There is no way back to routes without a decision. See [Authorization](docs/authorization.md#every-route-decides).

#### Medium: `Auth.attempt()` and `Auth.login()` can wait for a second factor

*Likelihood of impact: medium — only when an account has a second factor (TwoFactorState bound); an app that does not bind two-factor authentication never sees the new case.*

`attempt()` can now fail with `{ kind: 'two-factor-required', factors }` after a right password, and `login()` returns
`'signed-in' | 'two-factor-required'` instead of `void`. In that case nobody is signed in: no `Login` event, no remember-me cookie.
A caller that ignores the new case leaves the user signed out.

Before:

```ts
const signedIn = await auth.attempt(email, password);
if (!signedIn.ok) throw new ValidationError({ email: ['These credentials do not match.'] });

await auth.login(newUser);
return redirect('/dashboard');
```

After:

```ts
const signedIn = await auth.attempt(email, password);
if (!signedIn.ok) {
  if (signedIn.error.kind === 'two-factor-required') return redirect('/two-factor-challenge');
  throw new ValidationError({ email: ['These credentials do not match.'] });
}

if ((await auth.login(newUser)) === 'two-factor-required') return redirect('/two-factor-challenge');
return redirect('/dashboard');
```

A `switch` over `error.kind` that is exhaustive fails to compile until it handles the new kind; the starter kit's login page and the
`make:auth` stub do. The way back is not to bind two-factor authentication: the case never occurs without it. See
[Two-factor authentication](docs/two-factor-authentication.md).

#### Low: A custom `RememberTokenStore` has to return `createdAt`

*Likelihood of impact: low — only apps with their own `RememberTokenStore`; the database store of `@marmeon/auth` already does.*

`consume()` now returns `createdAt` next to `userId`, `cookie` and `expiresAt`: when the token was first made, kept across rotation,
written with the app's clock and a time zone. It must be the token's original creation time as a valid `Date`: never the time of
`consume()`, never `new Date()`. Two-factor authentication refuses a remember-me token whose `createdAt` is not after the factor was
turned on, so a wrong value lets tokens from before the factor through. TypeScript points to the store that lacks the field.

Before:

```ts
return ok({ userId: row.user_id, cookie, expiresAt });
```

After:

```ts
return ok({ userId: row.user_id, cookie, expiresAt, createdAt: new Date(row.created_at) });
```

There is no way back; the interface requires the field whether or not two-factor authentication is bound (at runtime it is read only with a `TwoFactorState` bound).

#### Low: `LoginVia` has a fourth member, `'passkey'`

*Likelihood of impact: low — only code that switches exhaustively over `Login.via`.*

A sign-in with a passkey alone reports `via: 'passkey'` next to `'attempt'`, `'login'` and `'remember'`. A `switch` over
`event.via` that must be exhaustive fails to compile until it handles the new value; nothing changes at runtime for an app that does not
bind passkeys.
