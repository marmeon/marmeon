# @bespokecore/auth

Authentication and authorization for BespokeCore apps: the session guard (`Auth`), remember-me, password hashing (argon2id or
scrypt from `node:crypto`), password reset, e-mail verification, API tokens, policies with the `Gate` and their projection
into pages — the **mechanics**. The auth **area** — pages, controllers, mails, migrations, tests — is generated into the app
by `bespoke make:auth` and belongs to the app from then on (Laravel Breeze's principle, E30).

```sh
pnpm add @bespokecore/auth
bespoke make:auth          # the auth module: modules/auth — yours to change
```

`bespoke discover` registers its `AuthServiceProvider` (the `"bespoke"` field of its `package.json`). The provider binds the
`Hasher` (built at the boot: a Node without argon2 stops the start with the fix, not the first login), `Auth` and `Gate` per
request, the token stores on the app's tables, adds `NoStoreWhenSignedIn` to the `web` group and — with `@bespokecore/cli` —
the commands `make:auth` and `auth:prune-tokens`. It needs [@bespokecore/session](../session/README.md) and
[@bespokecore/database](../database/README.md); what it does not know is where users come from: the app binds a
[`UserProvider`](#the-user-type-and-the-userprovider-e24).

## `bespoke make:auth`

```text
bespoke make:auth [--adapter=react] [--private-registration] [--force]
```

Copies `stubs/<adapter>/modules/auth` of this package to the app's `modules/auth/` (`react` is the only adapter with templates),
adds `import auth from '#modules/auth'` and `modules: [auth, …]` to `bootstrap/app.ts` (or says how), names the packages the
module imports that `package.json` lacks (`@bespokecore/cache`, `mail`, `queue`, `react`, `scheduler`, `session`, `mjml`,
`valibot`, …; it also imports [@bespokecore/i18n](../i18n/README.md)) and — when nothing is missing — runs
`bespoke route:types`. It needs `config/app.ts` exporting `AppConfig` (`APP_NAME`, `APP_URL`) — the app skeleton has one. An
existing `modules/auth` is never touched without `--force`. Then: `bespoke migrate` (with `NODE_ENV=development`, so it writes the table types), a jobs table for its queued mails
(`bespoke make:queue-table`, once) and `MAIL_*` in `.env`. The lint preset and the devtools belong to the app, not to the
module — `make:auth` names them while the app has neither: `bespoke make:lint-config` ([Lint](../cli/README.md#lint)) and
`pnpm add -D @bespokecore/devtools` ([@bespokecore/devtools](../devtools/README.md)). An app from `create-bespoke-app` has both
(E150) — its starter kit is this module, a home page and the blank app ([create-bespoke-app](../create-bespoke-app/README.md)).

What the module holds:

| | |
|---|---|
| `index.ts` | `defineModule({ … })`: provider, the queued listener `listen(Registered, SendEmailVerification)`, the job, migrations, `exposes: ['users']`, the seeder, `routes`, `apiRoutes`, `schedule` |
| `AuthServiceProvider.ts` | binds `UserProvider` to the `UserRepository`, the signed-in user's language (`LocalePreference`), `ShareAuthProps` in the `web` group, the rate limits `password-reset`, `register` (10/min per IP) and `verification` ([@bespokecore/cache](../cache/README.md)) |
| `users.ts`, `UserRepository.ts` | `type User = Row<'users'>` and the `AuthTypes` declaration; the repository implements `UserProvider` — the only code that reads the hash (`secret()`) |
| `routes.ts` | `/login`, `/register`, `/forgot-password`, `/reset-password` (behind `guest('/dashboard')`) — not `/`: that is the app's (the starter kit's home module); `/dashboard`, `/logout`, `/confirm-password`, `/settings/security`, `/settings/password`, `/settings/devices/logout`, `/settings/email`, `/settings/tokens` (sudo mode), `/email/verify…` (behind `authenticate()`) |
| `api-routes.ts` | `GET /api/user` behind `authenticate('api')` — Sanctum's `/api/user` |
| `controllers/` | 22 single-action controllers with their requests (`LoginController`: throttled per e-mail and IP, counted before the check) |
| `views/`, `layouts/` | `Login`, `Register`, `ForgotPassword`, `ResetPassword`, `ConfirmPassword`, `VerifyEmail`, `Dashboard`, `Security`, `AccessTokens`; `AppLayout`, `SettingsLayout` |
| `mail/` | `VerifyEmailMail`, `ResetPasswordMail`, `EmailChangedMail` (MJML) and their preview data |
| `listeners/`, `jobs/` | `SendEmailVerification` (queued), `SendPasswordResetLinkJob` (encrypted payload) |
| `middleware/ShareAuthProps.ts` | the shared `auth` prop (`{ user: { id, name, verified } \| null }`) and the `toast` flash type |
| `migrations/` | `users`, `remember_tokens`, `password_reset_tokens`, `personal_access_tokens` (prefixed `0001_01_01_…`: they run first) |
| `factories/`, `seeders/` | `UserFactory` (password `password`, hashed once at the test costs), `UserSeeder` (`test@example.com`) |
| `schedule.ts` | `s.command('auth:prune-tokens').daily().at('03:10').onOneServer()` |
| `lang/en.ts`, `abilities.ts`, `throttle.ts`, `reset-cookie.ts`, `verification.ts` | texts, the API token abilities (`TOKEN_ABILITIES`), the password-check throttle, the reset cookie, the `VerificationMailer` |
| `auth.test.ts`, `registration.test.ts` | the module's own tests (SQLite and Postgres) |

The generated forms carry no `_token` field: with JavaScript the client core sends `X-XSRF-TOKEN` when the session has one, and a
plain form post (no JavaScript) passes by the browser's word — Fetch Metadata, or `Origin` over plain HTTP (E143,
[CSRF](../session/README.md#csrf-protection)). A guest's pages hand out no token and keep no session. Only a browser that sends
neither header needs the token — `<Form>` renders `page.csrf` for that when there is a session.

### Private registration (`--private-registration`, E146)

By default the registration works like Laravel Breeze's: a taken address is a field error — when the field is checked live (E62)
and on submit — and a new account is signed in at once; the throttle (`register`, 10/min per IP, E100) is what keeps it from
being a cheap way to find out who has an account. `--private-registration` writes a variant over the module that never tells:

- **The same answer, in the same time:** a new and a known address both get a redirect to `/register/sent` ("check your inbox")
  — no session, no cookie, byte for byte alike. The password is hashed either way (the hash is what takes the time), and either
  way the request queues one job: the verification mail's listener, or `SendAccountExistsMailJob` (encrypted payload).
- **A note instead of "taken":** the owner of a known address gets `AccountExistsMail` (sign in, or choose a new password);
  what was typed into the form is thrown away.
- **No live check of the address:** the schema asks no database — live validation checks the e-mail's form only.
- **A confirmed address first:** nobody is signed in by registering; the new account signs in like any other and sees only the
  verification notice until it clicks the link from its inbox while signed in (`verified()` on the app's routes). Whoever signed up
  first with somebody else's address cannot confirm it — and the owner takes it over with a password reset.

It writes `controllers/RegisterController.ts`, `controllers/ShowRegistrationSentController.ts`, `views/Register.tsx`,
`views/RegistrationSent.tsx`, `jobs/SendAccountExistsMailJob.ts`, `mail/AccountExistsMail.ts`, `routes.ts`, `index.ts` and
`registration.test.ts` over the default module (`stubs/<adapter>/private-registration/`); the texts are in the default `lang/en.ts`.
The price: someone who forgot they have an account learns it only from their inbox, and nobody can start before the mailer and a
queue worker run. The web app runs it — `verified()` on every page of its modules; an unconfirmed account sees the notice.

From then on the app owns all of it: change the pages, the routes, the user table, the rules. What stays in the package — and
what updates bring — is the mechanics below. `apps/web-app/modules/auth/` is such a module, grown further (private registration,
a welcome mail, sign-in notifications, German texts, tokens in layers).

## The user type and the UserProvider (E24)

The app declares its user type once — `ctx.user`, `auth.user()`, `actingAs()` and the `UserProvider` are typed by it:

```ts
// modules/auth/users.ts
export type User = Row<'users'>;     // without the hash: `password` is a secret column

declare module '@bespokecore/auth' {
  interface AuthTypes {
    user: User;
  }
}
```

Without it `ctx.user` is `AuthTypesNotDeclared`, whose every use names the declaration. Users need an `id` (string or number).

```ts
// container.bind(UserProvider, (c) => c.make(UserRepository)) — in the auth module's provider
export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  findById(id: number): Promise<Credentials<User> | undefined> { … }        // the user and their current hash
  findForLogin(email: string): Promise<Credentials<User> | undefined> { … } // by what people type, normalized by the request
  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> { … }
}
```

`Credentials` is `{ user, passwordHash }`: the hash travels **next to** the user, never inside it (`passwordHash: null` for users
who cannot sign in with a password). Until a provider is bound, the first use of `UserProvider` throws with this setup.

## Signing in: `Auth`

`Auth` is the session guard of the `web` group, injected per request:

```ts
constructor(auth: Auth) { … }

if (!(await this.#auth.attempt(email, password, { remember }))) {
  throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
}
return this.redirect().intended().route('dashboard');
```

| Method | |
|---|---|
| `attempt(identifier, password, { remember?, ip?, userAgent? })` | checks and signs in (`ip`/`userAgent` only to say something other than the request's — the `Login` event takes those by itself, `RequestInfo`) — `undefined` for an unknown identifier and a wrong password alike, in the same time (`dummyVerify`); rehashes when the costs changed; notes the password as just confirmed |
| `login(user, options?)` | signs a user in without a password (after registering) |
| `logout()` | sign-out on this device: session data, id and CSRF token replaced, the remember-me token dropped |
| `user()`, `check()`, `id()` | who is signed in — looked up once per request, from the session, else the remember-me cookie |
| `viaRemember()` | signed in by the remember-me cookie, not a password |
| `confirmPassword(password)`, `passwordRecentlyConfirmed(seconds?)` | sudo mode — see `confirmedPassword()` |
| `updatePassword(password)` | a new password: every other session ends, every remember-me token goes (this device's too), `PasswordChanged` |
| `logoutOtherDevices(password)` | checks the password and hashes it anew (a new salt): every other session ends, the other devices' remember-me tokens go |

- **A new session at every sign-in:** the session id and CSRF token handed out before are replaced (session fixation).
- **The session holds a fingerprint of the hash** (a SHA-256 of it, `_auth_password`), not the hash. A password change anywhere
  changes the hash, so every other session stops matching and ends at its next request. A deleted user ends the same way.
- **Sign-in and sign-out reset the browser's history:** the next page loads fully, so pages kept from before do not come
  back; `logout()` also sends `Clear-Site-Data: "cache", "storage"` (E165: the HTTP cache and the site's storage, in every tab —
  `history.clear({ siteData: ['cache'] })` after `logout()` keeps the storage) — `ClientHistory` and the 409 of
  [the protocol](../http/README.md#the-protocol). The other tabs of the browser follow by
  [tab sync](../http/README.md#tab-sync-w8-step-8): the session's epoch changes with every sign-in and sign-out.
- **Islands cannot sign in** (read-only requests, E52): for them a session whose password changed is a guest, and the
  remember-me cookie waits for the page's request.
- The session keys (`AUTH_SESSION_KEYS`) start with `_`: framework bookkeeping, left out of `session.all()`. The `database`
  session driver copies `_auth_id` into `user_id`.

### Remember me (E26)

`attempt(…, { remember: true })` sets an encrypted, HttpOnly cookie (`AUTH_REMEMBER_COOKIE`, `remember_web`) valid for
`AUTH_REMEMBER_DAYS` from the sign-in — never extended by use. One token per device in `remember_tokens`: the cookie is
`<selector>.<validator>`, the table keeps the validator only as SHA-256. Every use rotates the validator (a second tab racing
the rotation is let through for 60 s); an old validator coming back later means the cookie was copied — every token of the
user is dropped and a warning is logged. Bind your own `RememberTokenStore` to keep them elsewhere.

## Middleware

```ts
const guests = Route.middleware(guest('/dashboard'));
guests.get('/login', ShowLoginController).name('auth.login');

const signedIn = Route.middleware(authenticate());                       // ctx.user
signedIn.middleware(confirmedPassword()).get('/settings/security', ShowSecurityController).name('auth.security');
signedIn.middleware(verified()).post('/users/:user/links', AddProfileLinkController).name('links.store');

Route.middleware(authenticate('api')).middleware(abilities('users:read')).get('/users', ListUsersController);   // api-routes.ts
```

| | Lets through | Otherwise |
|---|---|---|
| `authenticate({ loginRoute? })` | a signed-in user — `ctx.user` | JSON: 401; browsers: a redirect to `auth.login`, the page remembered for `redirect().intended()` (not for prefetches or islands) |
| `authenticate('api')` | `Authorization: Bearer <token>` — `ctx.user` and `ctx.token` | 401 with `WWW-Authenticate: Bearer` — a session cookie counts for nothing here |
| `guest(home = '/')` | guests | a redirect to `home` |
| `confirmedPassword({ confirmRoute?, seconds? })` | a password typed within `AUTH_PASSWORD_TIMEOUT` (15 minutes) | JSON: 423; browsers: `auth.password.confirm`, then back |
| `verified({ noticeRoute? })` | a user whose `email_verified_at` is set (after `authenticate()`) | JSON: 403; browsers: `auth.verification.notice` |
| `abilities(...names)` | a token that grants every ability (after `authenticate('api')`) | 403 naming what is missing |

The route names are checked against the app's routes (`CheckRouteName`).

## Password hashing

```ts
constructor(hasher: Hasher) { … }

const hash = await this.#hasher.make(ctx.body.password);   // '$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>'
await this.#hasher.verify(password, hash);                  // constant time; a broken or tampered hash is false, never a throw
this.#hasher.needsRehash(hash);                             // another driver or other costs (attempt() rehashes by itself)
await this.#hasher.dummyVerify(password);                   // as long as a verify, always false — for unknown accounts
```

- **Drivers:** `argon2id` (the default, OWASP's first choice: 19 MiB, 2 passes, 1 lane) and `scrypt` (N = 2¹⁷, r = 8, p = 1) —
  both from `node:crypto`, computed in libuv's thread pool. argon2 needs Node ≥ 24.7 built with OpenSSL ≥ 3.2 (the official
  builds); without it the start fails and names `HASH_DRIVER=scrypt` (`argon2Available()` asks).
- **PHC strings** (`$argon2id$…`, `$scrypt$ln=17,r=8,p=1$…`), branded as `PasswordHash`: `verify(hash, password)` — swapped —
  does not compile. Hashes of either driver verify whatever is configured: switching drivers needs no mass reset.
- **Bounds (`HASH_LIMITS`)** for the configuration *and* every stored hash before it is used: a planted hash asking for 4 GiB
  is refused, not computed.
- **Passwords** are never trimmed, but Unicode-normalized (NFKC, as NIST SP 800-63B asks), at most `MAX_PASSWORD_BYTES`
  (4096) long; strings with lone surrogates are refused (`HashError`).

## Password reset

`PasswordBroker` (Laravel's password broker) on `password_reset_tokens` — one token per e-mail, 256 random bits stored as
SHA-256, used once:

```ts
const reset = await this.#broker.createToken(payload.email);   // { user, token } — undefined: no account, or within AUTH_RESET_THROTTLE
if (reset) await this.#mailer.queue(new ResetPasswordMail(reset.user, link(reset.token), …), { queue: 'mail' });

const user = await this.#broker.reset(email, token, ctx.body.password);   // undefined: unknown e-mail, wrong, used or expired token
```

A link works for `AUTH_RESET_EXPIRE` minutes. A reset sets the new hash — every session of the user ends, its fingerprint no
longer matches — drops every remember-me token and dispatches `PasswordReset`. The generated module answers the request the same way for known and unknown addresses
— it only queues `SendPasswordResetLinkJob` (encrypted, E105), which makes the token and queues the mail; the link's token
moves from the query into an encrypted cookie on the reset page.

## E-mail verification

```ts
const url = this.#verification.link(user, { base: this.#app.url });           // signed, 60m, route auth.verification.verify (:id, :hash)
if (!this.#verification.matches(ctx.user, ctx.params)) abort(403, …);         // behind authenticate() and signed()
```

`EmailVerification` signs a temporary route with the user's id and a hash of the address (`emailHash()`): a link for an old
address stops working when the address changes, and a valid signature of someone else's link is not enough — `matches()`
compares it with the signed-in user. Options: `expiresIn` (default `60m`), `route`. `verified()` guards the routes that need a
confirmed address; the user type needs `email_verified_at`. Signed URLs are
[@bespokecore/http](../http/README.md)'s `UrlSigner` and `signed()`.

## API tokens (E27)

Personal access tokens, Sanctum-style, on `personal_access_tokens`:

```ts
const { plainText, token } = await this.#tokens.create(ctx.user.id, 'CLI', { abilities: ['users:read'], expiresIn: '90d' });
// plainText: 'bc_12|<40 characters><crc32>' — shown once, never stored; the table keeps a SHA-256 of the secret
await this.#tokens.list(ctx.user.id);              // AccessToken[]: id, name, abilities, lastUsedAt, expiresAt, createdAt
await this.#tokens.revoke(ctx.user.id, id);        // false when the user has no such token
```

- **Format:** `AUTH_TOKEN_PREFIX` (`bc_`, so secret scanners recognize leaked tokens), the row id, 40 random characters and a
  CRC32 over all of it — a typo fails in `parseAccessToken()` without a query. 62⁴⁰ possibilities need no slow hash.
- **Abilities:** `['*']` by default; `tokenCan(token, ability)` and `abilities(…)` check them. Without `expiresIn` a token
  lives until revoked; `touch()` notes its use at most once a minute.
- **Guard:** `authenticate('api')` in the stateless `api` group (`apiRoutes` of a module, under `/api`): no session, no
  cookies. The generated module offers creating and revoking tokens in sudo mode only — a token is as good as a session.

## Authorization: policies and the `Gate` (E28)

A policy is a plain class — injectable, built in the request's scope, nothing to register. Its methods take the user and
what they are about, and answer `true`/`false`, `allow()`, `deny(message?)` (403) or `denyAsNotFound()` (404, the client
cannot tell a hidden record from a missing one):

```ts
// modules/user-profile/policies/ProfilePolicy.ts
export class ProfilePolicy {
  update(user: AuthUser, profile: { readonly id: number }) {
    return user.id === profile.id || deny('user-profile.validation.own_profile');   // a key: the exception handler translates it
  }
  viewEmail(user: AuthUser, profile: { readonly id: number }) {
    return user.id === profile.id;
  }
}
```

```ts
export const UpdateUserProfileRequest = defineRequest({
  schema: v.object({ … }),
  authorize: can(ProfilePolicy, 'update', 'user'),   // ctx.params.user — after route binding, before validation
});

// in a controller — constructor(gate: Gate)
await this.#gate.authorize(ProfilePolicy, 'update', user);           // throws AuthorizationError: 403 (with deny's reason) or 404
await this.#gate.allows(ProfilePolicy, 'viewEmail', user);           // also denies(), inspect() — the PolicyResponse
```

Everything is named and typed: `can(ProfilePolicy, 'updte', 'user')` does not compile, and a route parameter bound to the
wrong type, or not bound at all, is a compile error where the controller is registered. `can()` takes a route parameter's name or
`(ctx) => resource`; abilities without a resource take neither. Guests are denied before any policy runs. A policy's
`before(user, ability)` may decide first (`true`/`false`); `undefined` lets the ability decide.

### Abilities for the page (E61)

What the page may offer — one boolean per named ability, never a `deny()` reason:

```ts
return this.view('user-profile/Show', {
  abilities: this.#gate.abilities(user, ProfilePolicy, ['update']),                  // the view: abilities.update
  profile: async () => ({ ...user, links: await this.#gate.withAbilities(links, ProfileLinkPolicy, ['delete']) }),   // link.can.delete
});
this.#gate.abilities(DashboardPolicy, ['viewMembers']);                               // abilities without a resource
```

A projection is lazy: as a page prop it runs only when the response includes it (a partial reload for other props never asks
the policy) — project inside a prop to refresh both together. `withAbilities` calls the policy once per row and ability
(`before()` once per ability). The UI's hint only: the server checks again on every request.

## Validation rules

```ts
schema: confirmed(v.object({ password: password(), password_confirmation: v.string() })),
schema: (resolve) => confirmed(v.objectAsync({ email: v.pipeAsync(…, v.checkAsync(…)), password: password(), … })),
```

- **`password({ min = 8, messages? })`** — long enough (code points after NFKC: an emoji is one), at most 4 KiB, well-formed;
  no composition rules (NIST advises against them). Messages are translation keys `bespoke.validation.password.*` by default.
- **`confirmed(schema, { field = 'password', confirmation = 'password_confirmation', message? })`** — the confirmation
  repeats the field (after the same normalization), reported on the confirmation field; sync and async schemas. It runs once
  the whole body is valid — a live validation (E62) never sees it.

## Events

Dispatched through the app's `EventDispatcher` (tests see them in `app.events`):

| Event | When | Fields |
|---|---|---|
| `Login` (`auth.login`, queueable) | `attempt()`, `login()`, a remember-me sign-in | `user`, `remember`, `at`, `via` (`attempt` \| `login` \| `remember`), `ip`, `userAgent` (the request's — `RequestInfo`, the address through `TRUSTED_PROXIES`, E169 — or what the app passed; null outside a request) |
| `Logout` | `logout()` | `user` |
| `Failed` | `attempt()` with an unknown identifier or a wrong password | `identifier` (never the password), `user` if known — for audit logs, never for the client |
| `Lockout` | the app's login throttle (the generated `LoginController`) | `identifier`, `ip` |
| `Registered` (`auth.registered`, queueable) | the app, after creating the account | `user` |
| `PasswordChanged` | `updatePassword()` | `user` |
| `PasswordReset` | `PasswordBroker.reset()` | `user` |

A queued listener (`static queue`, [@bespokecore/queue](../queue/README.md)) of `Login` gets `{ userId, remember, via, at, ip,
userAgent }`, one of `Registered` `{ userId }` — and reads the account as it is when it runs.

## Signed-in answers are never cached

`NoStoreWhenSignedIn` in the `web` group sets `Cache-Control: no-store, private` (`NO_STORE`) on every answer while someone is
signed in — pages, their JSON, redirects, error pages — so "Back" after signing out shows nothing from the HTTP cache. It asks
the session, not the user table. A route that sets its own `Cache-Control` keeps it.

With `SESSION_DRIVER=cookie` the boot logs a warning (`COOKIE_SESSION_WARNING`): a request still in flight can bring a
signed-out session back. Use `file`, `database` or `redis` for apps with login —
[concurrent requests and signing out](../session/README.md#concurrent-requests-and-signing-out).

## Pruning tokens

```text
bespoke auth:prune-tokens [--hours=0]
```

Deletes reset tokens older than `AUTH_RESET_EXPIRE`, expired remember-me tokens and API tokens that expired more than
`--hours` ago (they stop working when they expire, but stay listed until pruned). Valid tokens stay. The generated module
schedules it nightly — [@bespokecore/scheduler](../scheduler/README.md).

## Configuration

Environment only (`AuthConfig` and `HashConfig`, injectable like every [configuration](../core/README.md#configuration)):

```sh
HASH_DRIVER=argon2id              # argon2id | scrypt
HASH_ARGON_MEMORY=19456           # KiB per hash (1024–262144)
HASH_ARGON_TIME=2                 # passes (1–16)
HASH_ARGON_PARALLELISM=1          # lanes (1–16)
HASH_SCRYPT_COST=17               # log2 of N (10–20)
HASH_SCRYPT_BLOCK_SIZE=8          # r (1–32); 128 · N · r must stay within 256 MiB
HASH_SCRYPT_PARALLELISM=1         # p (1–16)
AUTH_REMEMBER_DAYS=30             # remember-me, counted from the sign-in
AUTH_REMEMBER_COOKIE=remember_web
AUTH_PASSWORD_TIMEOUT=900         # seconds a confirmation counts for confirmedPassword()
AUTH_RESET_EXPIRE=60              # minutes a reset link works
AUTH_RESET_THROTTLE=60            # seconds before another reset link for the same e-mail
AUTH_TOKEN_PREFIX=bc_             # API tokens; lower-case letters, digits and _, at most 16
```

`HashConfig` resolves to `{ driver, argon2: { memory, time, parallelism }, scrypt: { cost, blockSize, parallelism } }`,
`AuthConfig` to `{ rememberDays, rememberCookie, passwordTimeout, resetExpire, resetThrottle, tokenPrefix }`. Tests set cheap
costs in `.env.test` (`HASH_ARGON_MEMORY=1024`, `HASH_ARGON_TIME=1`) — they check behaviour, not strength.

## Testing

[@bespokecore/testing](../testing/README.md) signs in through this package — `authenticatedSession()` and
`authenticatedToken()` build what a login or a token leaves:

```ts
await app.actingAs(ada).get('/dashboard').assertOk();                                       // the session a login leaves
await app.actingAs(ada, { guard: 'api', abilities: ['users:read'] }).get('/api/users').assertOk();   // a real token
await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertAuthenticated(ada);
await app.actingAs(ada).post('/logout').assertRedirect('/login').assertGuest();
app.events.assertDispatched(Registered);
```

The user must exist (a factory). `actingAs()` needs a server-side session driver in tests (`SESSION_DRIVER=memory`).
