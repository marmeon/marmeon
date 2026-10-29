# Authentication

## Introduction

Authentication answers one question for every request: who is this? `@marmeon/auth` holds the mechanics: the session guard
`Auth`, "remember me", the middleware that protects routes and the events of signing in and out. The pages people see, such as the
login form and the registration, belong to your app. The [starter kit](starter-kit.md) writes them for you as the `auth` module.

A route that only signed-in users may reach puts `authenticate()` in front of its controller. The controller then finds the user
in `ctx.user`:

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(verified()).get('/notes', ListNotesController).name('notes.index');
});
```

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';

export class ListNotesController extends Controller {
  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    return this.view('notes/Index', { notes: await this.#notes.forUser(ctx.user.id) });
  }
}
```

`verified()` lets in only accounts whose address is confirmed. Put it on every route of your own that signed-in users reach: the
[email verification](verification.md#requiring-a-confirmed-address) page explains why.

## What the package decides

The starter kit's controllers are thin. Every decision that matters for security sits in a service of `@marmeon/auth`, so an app with
controllers of its own gets it too, and an update of the package brings a fix to both. A service is a class from the container;
only the stores and the `UserProvider` are contracts you may implement ([what your app implements](#what-your-app-implements)).

| Service or command | What it decides | Section |
| --- | --- | --- |
| `Auth.attempt()` | The limits of a password sign-in before the password is read: per client and identifier, per account and day, and the device cookie that keeps the owner in. | [Limits on password sign-ins](#limits-on-password-sign-ins) |
| `Auth.checkPassword()` | A signed-in user's password check, counted before it is made, with a limit per day; it starts sudo mode. | [How password checks are counted](#how-password-checks-are-counted) |
| `EmailVerification`, `verified()` | The signed link that confirms an address, and the middleware that lets in only confirmed accounts. | [Email verification](verification.md) |
| `PasswordBroker`, `Auth.updatePassword()` | The single-use reset link, the same answer for every address, and the end of the other sessions. | [Password reset](passwords.md), [changing the password](#changing-the-password) |
| `EmailChange` | A change of address with a fresh factor, a throttled password and a single-use link, the same answer for a free and a taken address. Your app writes the address. | [Changing the address](#changing-the-address) |
| `TwoFactor`, `Passkeys` | The factors, their codes and challenges, the password every change asks for, and the sessions that end when a passkey is removed or looks copied. | [Two-factor authentication](two-factor-authentication.md) (`@marmeon/auth/two-factor`), [passkeys](passkeys.md) (`@marmeon/auth/passkeys`) |
| `AccountSessions` | Ending the sessions of one account or of every account. | [Ending every session of a user](#ending-every-session-of-a-user) |
| `auth:end-sessions`, `auth:end-all-sessions`, `auth:reset-two-factor`, `auth:prune-tokens` | The operator's commands. | [Ending every session of a user](#ending-every-session-of-a-user), [of every account](#ending-every-session-of-every-account), [operator reset](two-factor-authentication.md#operator-reset) |
| `auth.*` limiters | The rate limits of the auth routes; an app's limiter of the same name replaces one. | [The limits of the auth routes](#the-limits-of-the-auth-routes) |

The package needs `@marmeon/cache` for the limits: `Auth` stops at boot without it. The stores of sign-ins, reset tokens and API
tokens come with a database default, and `TwoFactorState` defaults to none. Only `EmailChange` is opt-in: without a bound
`EmailChangeStore` it fails with K1 when it is built. The `AUTH_*` settings are in the [configuration](#configuration) table.

What stays with the app is what depends on its data: the `users` table and its `UserProvider`, the controllers and their fields,
the views, the mails and the routes. The registration is the app's too, since its answers depend on its fields, and so is
`auth:prune-unverified`, which deletes accounts. The [starter kit](starter-kit.md) page lists what it wires for you.

## The user type and where users come from

The package does not know your users. Your app tells it twice: which type a user has, and where to find one.

The type is declared once, and `ctx.user`, `auth.user()` and the test helpers take it from there:

```ts title="modules/auth/users.ts"
import type { Row } from '@marmeon/database';

export type User = Row<'users'>;

declare module '@marmeon/auth' {
  interface AuthTypes {
    user: User;
  }
}
```

`Row<'users'>` leaves out the password hash, because the migration marks the column as secret. A user needs an `id`, a string or
a number. Without the declaration, `ctx.user` has the type `AuthTypesNotDeclared`, and every use of it names the declaration it
is missing.

Users come from a `UserProvider`. The starter kit's `UserRepository` is one, and its provider binds it with
`container.bind(UserProvider, (c) => c.make(UserRepository))`:

```ts title="modules/auth/UserRepository.ts"
import { credentialWriter, type Credentials, type PasswordHash, type UserProvider } from '@marmeon/auth';
import { Repository, secret } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  findForSignIn(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  // Compare-and-set in one statement, with the optional session key: the statements live in the package, see below.
  updatePasswordHash(id: number, hash: PasswordHash, options?: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null }): Promise<boolean> {
    return credentialWriter(this.db).updatePasswordHash(id, hash, options);
  }

  // updateSessionKey() and updateEverySessionKey() delegate the same way, see below.

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query.selectAll().select((eb) => [secret(eb, 'password'), secret(eb, 'session_key')]).executeTakeFirst();
    if (!row) return undefined;
    const { password, session_key, ...user } = row;
    return { user, passwordHash: password as PasswordHash, sessionKey: session_key };
  }
}
```

The example leaves out `updateSessionKey()` and `updateEverySessionKey()`, which a provider needs as well, see
[signing out other devices without a password](#signing-out-other-devices-without-a-password) and
[for your own user provider](#for-your-own-user-provider). The starter kit's `UserRepository` has all of them, and a provider of
your own that leaves one out does not compile.

`Credentials` is `{ user, passwordHash, sessionKey }`: the hash travels next to the user, never inside it, so it cannot reach a page by
accident. A user who cannot sign in with a password has `passwordHash: null`. The `sessionKey` is a value of
the account that ends its other sessions when it changes, as [signing out without a password](#signing-out-other-devices-without-a-password)
explains; it is `null` for an account that has none yet. Both `findById()` and `findForSignIn()` must return it: a `findForSignIn()` that
leaves out a key `findById()` returns makes `attempt()` throw, and a bad sign-in is not what it reports. `findForSignIn()` gets what the person typed after
the request's schema normalized it; the starter kit's schema trims the address and makes it lower case. Compare it exactly (binary,
case-sensitive) with the stored, normalized address: a database collation that treats `é` and `e`, or trailing spaces, as equal finds
an account for a spelling that has a counter of its own, and so lets anyone test which spellings an account answers to. Until a provider is
bound, the first use of `UserProvider` throws an error that says how to bind one.

`updatePasswordHash(id, hash, { expected, sessionKey })` returns whether it wrote, and is a compare-and-set when `expected` is given: it
writes only where the stored hash still equals `expected`, in one statement. With `sessionKey` the same statement stores that session key.
`attempt()` rehashes over the hash it verified, so a password reset that lands in between is never turned back to the old password:
the rehash makes the sign-in an `invalid-credentials` (a new attempt checks the new password). A rehash passes no `sessionKey`: it
changes the hash and nothing a session is bound to, so no sign-in ends. A reset or a new password passes no `expected`, writes
regardless, and **always passes a new `sessionKey`**: the key is what ends the other sessions, and `findById()` has to hand it back at once.
The framework reads it back after the write and refuses a provider that ignored it with error A5 (see [error
codes](errors.md#server-error-codes)). The answer must be a boolean: a provider that returns nothing is refused with the same error at
the first write, since it could turn a reset back without anyone noticing.

A new password of the signed-in user (`updatePassword()`) also passes `expectedSessionKey`, the key its session was checked against
(`null` for an account without one). With `sessionKey`, write only where the stored key equals it, in the **same** statement
(`session_key IS NULL` for `null`, else `session_key = ?`), and return `false` otherwise: an `AccountSessions.end()` that landed after the
session was checked has replaced the key, and a password change must not write over it, or the session `end()` just ended would come
back. A `false` there is no contract break: `updatePassword()` signs this session out and throws. **A provider must evaluate
`expectedSessionKey`.** One that ignores it still passes the read-back, and the framework cannot tell, so the protection is silently gone: test it in
your app (a write over a stale `expectedSessionKey` must return `false` and leave the row alone). `updateSessionKey(id, key, null)` compares
with `IS NULL` for the same reason.

The new password and the read-back run in one database transaction (`NewPassword` always opens one), so an error A5, or a lost
`expectedSessionKey`, rolls the hash and the revocation of API tokens back, where your provider writes through the same connection (the
starter kit's does). A provider that writes elsewhere keeps what it wrote: after an A5 the new hash may be stored without the key, and
no session ended. Fix the provider, then end the sessions with `AccountSessions.end()`.

Give every account a key when you create it (32 random bytes, `base64url`, as `auth.updateSessionKey()` draws them). The contract
still allows `null`, but a `null` key cannot be locked when a factor is added, and the framework can only compare against it, not hold
the row. The starter kit's `register()`, factory and seeder do, and its upgrade migration fills the `NULL` keys of existing accounts with
random values (an account that had none is signed out once, since its fingerprint changes).

## Protecting routes

The package brings four middleware for the routes of the `web` group:

| Middleware | Lets through | Everyone else |
| --- | --- | --- |
| `authenticate()` | A signed-in user, as `ctx.user`. | A browser goes to the login page, a JSON client gets 401. |
| `guest(home)` | Guests. For the login and registration pages. | A redirect to `home`, `/` by default. |
| `verified()` | A user whose `email_verified_at` is set. After `authenticate()`. | A browser goes to the notice, `auth.verification.notice`. A JSON client gets 403. |
| `confirmedPassword()` | A user who typed the password or proved a passkey within 15 minutes by default ([how long](#how-long-a-sign-in-lasts)). After `authenticate()`. | A browser goes to `auth.password.confirm`, a JSON client gets 423. |
| `confirmedSecondFactor({ verify })` | A user whose account has no second factor, or whose session proved one within 15 minutes by default ([how long](#how-long-a-sign-in-lasts)). After `confirmedPassword()`, on routes that change factors, the e-mail address or API tokens. | A browser goes to `verify`, a JSON client gets 403. See [changing the factors](two-factor-authentication.md#changing-the-factors). |
| `twoFactor({ setup, verify, maxAge? })` | A user whose session proved a second factor. After `authenticate()`; never installed by the framework. | A browser goes to `setup` or `verify`, a JSON client gets 403. See [requiring it](two-factor-authentication.md#requiring-it). |

`authenticate('api')` checks an API token instead of the session. The [API tokens](api-tokens.md) page covers it, and the
[middleware](middleware.md#middleware-of-the-framework) page lists the middleware of every package.

A guest whom `authenticate()` turns away goes to the route named `auth.login`, or the one `authenticate({ loginRoute })` names.
For a `GET` visit, the page they wanted is kept in the session, and `this.redirect().intended()` after the sign-in brings them
back there. A prefetch and a request that only reads are not remembered. A client that expects JSON gets
`401 {"message":"Unauthenticated."}` instead of the redirect.

#### Sending a guest from an open page to sign in and back

A page anyone may open, such as an invitation, has no `authenticate()` in front of it, so it remembers nothing. Give it a thin
`GET` route behind `authenticate()` and link "Sign in" to that route. A guest who follows the link is turned away, the middleware
keeps the route's path, and `intended()` brings the guest back to it after the sign-in. A signed-in user passes straight through:

```ts title="modules/invitations/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { JoinInvitationController } from './controllers/JoinInvitationController.ts';
import { ShowInvitationController } from './controllers/ShowInvitationController.ts';

export default defineRoutes((Route) => {
  Route.get('/invitations/:token', ShowInvitationController).name('invitations.show');
  Route.middleware(authenticate()).get('/invitations/:token/join', JoinInvitationController).name('invitations.join');
});
```

```ts title="modules/invitations/controllers/JoinInvitationController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

export class JoinInvitationController extends Controller {
  handle(ctx: HttpContext<Authenticated, { token: string }>) {
    return this.redirect().route('invitations.show', { token: ctx.params.token });
  }
}
```

The "Sign in" link on the invitation page points at `/invitations/<token>/join`. After the sign-in, `LoginController` ends with
`this.redirect().intended().route('dashboard')` and the guest lands on the join route, which sends the now signed-in user back to
the invitation. Accept it there with a form that posts: the join route is a `GET`, which a browser may prefetch, so it changes
nothing.

Do not carry the target in a `?next=` parameter. Anyone can send a link with a `next` that leads to another site, and the sign-in
would follow it; the path kept in the session was written by `authenticate()` itself, and `intended()` follows only a path of this
site.

Every route name these middleware take, `loginRoute`, `noticeRoute` and `confirmRoute`, is checked against your routes when you
compile. The defaults are the names of the starter kit's routes.

### The signed-in user

Behind `authenticate()`, `ctx.user` is the user. Elsewhere, and in classes that get no context, inject `Auth`:

| Method | Returns |
| --- | --- |
| `user()` | The signed-in user, or `undefined`. |
| `check()` | Whether someone is signed in. |
| `id()` | The user's id, or `undefined`. |
| `viaRemember()` | Whether the session was signed in by the remember-me cookie rather than a password. |

`Auth` belongs to the request, like the session. It looks the user up once per request: from the session, or else from the
remember-me cookie. The lookup also checks that the user's password has not changed since the session signed in, as the section
on [ending every session of a user](#ending-every-session-of-a-user) explains.

## Signing in

`attempt()` checks a password and signs the user in, and it limits itself (see [Limits](#limits-on-password-sign-ins)). The
starter kit's `LoginController` only maps its answers:

```ts title="modules/auth/controllers/LoginController.ts"
import { Auth } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const LoginRequest = defineRequest({
  schema: r.object({
    email: r.string().trim().lowercase().required().max(255).email(),
    password: r.string().required().max(4096),
    remember: r.boolean().default(false),
  }),
});

export class LoginController extends Controller {
  static request = LoginRequest;

  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password, remember } = ctx.body;
    const signedIn = await this.#auth.attempt(email, password, { remember });
    if (signedIn.ok) return this.redirect().intended().route('dashboard');
    switch (signedIn.error.kind) {
      // The password was right, but the account has a second factor: nobody is signed in yet, the code comes next.
      case 'two-factor-required':
        return this.redirect().route('auth.two-factor.challenge');
      case 'throttled': {
        const message = signedIn.error.account ? this.#translator.get('auth.login.locked') : this.#translator.get('auth.login.throttled', { seconds: signedIn.error.retryAfterSeconds });
        throw new ValidationError({ email: [message] }, { email });
      }
      case 'invalid-credentials':
        throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
    }
  }
}
```

`attempt(identifier, password, { remember })` returns a [`Result`](errors.md#results): `ok` with the user, or an `err` of kind
`invalid-credentials`, `two-factor-required` or `throttled`. An unknown address, a wrong password and an account without a password all give
`invalid-credentials`, the same answer in the same time: for an unknown address, the hasher spends as long on a check that always
fails. A failed attempt also waits until it has taken as long as a check over the slowest hash parameters this process has
verified, so accounts with an older hash (after a change of driver or costs) are not told apart either, see
[hashing](hashing.md#making-and-checking-hashes). Neither the answer nor its duration tells a stranger which addresses have an
account.

`two-factor-required` comes only after a correct password, for an account that set up a [second
factor](two-factor-authentication.md). Nobody is signed in then: no `SignedIn` event, no remember-me cookie, `auth.user()` is
`undefined`. The session keeps the right password for five minutes, `auth.pendingSecondFactor()` names the factors it waits for,
and the error carries them as `factors`. Redirect to the page that asks for the code. An app that ignores the case still signs
nobody in. Without a source of factors bound (see [Setting up](two-factor-authentication.md#setting-up)) the case never happens. When the stored hash was made with other costs than the
configured ones, `attempt()` hashes the password again and stores the new hash; no session of the account ends by it (see [changing the
password](#changing-the-password)). It also notes the time, so the password counts as
just confirmed for [sudo mode](#sudo-mode).

### Limits on password sign-ins

`attempt()` counts every password sign-in before it reads the account or checks the password, in one atomic step, so guesses sent
at once cannot all slip past a limit. An app with its own login controller has them without writing any of it.

| Limit | Default | Setting | Answer |
| --- | --- | --- | --- |
| One identifier from one client (an IPv6 address counts as its /64) | 5 a minute | `AUTH_LOGIN_ATTEMPTS_PER_MINUTE` (1 to 60) | `throttled` with `retryAfterSeconds` |
| One account, from all clients together | 100 a day | `AUTH_ACCOUNT_SIGN_INS_PER_DAY` (10 to 100000) | `throttled` with `account: true` |
| One device cookie of the account's owner, instead of the line above | 10 an hour | fixed | after that the cookie counts as none |

A held-up attempt checks no password, the right one included, and does no hashing. Past the account's ceiling waiting does not
help: the way back in is a [password reset](passwords.md) or a [passkey](passkeys.md). For an identifier without an account the
answer, the lookup and the count are the same as for one with an account, so the limit tells nothing about which addresses exist.
A password sign-in of the owner, a sign-in by passkey or second factor, and a password reset start the account's count over; a
right password clears the minute of that client. A sign-in through the remember-me cookie does not: a stolen cookie must not
reset the budget of guesses. Refusals of the ceiling wait as long as a wrong password does. The spellings of an address that differ in case or surrounding spaces share their
counts.

The counts live in the [cache](cache.md) under keys that hold no address: the identifier is an HMAC under a key derived from
`APP_KEY` (an account that exists is counted by its id), so a dump of the cache is no list of addresses that were tried. They are
short-lived, so changing `APP_KEY` only starts them over. `Auth` needs `@marmeon/cache` for this: the boot stops without it.

Anyone who knows only an address can use up the account's ceiling and so keep its owner from signing in with the password. The
**device cookie** is the answer, after the OWASP pattern of device cookies: a browser that signs in with the password, or completes a
password reset, gets a signed, long-lived cookie (`marmeon_device`, with the `__Host-` prefix over HTTPS; `HttpOnly`, `SameSite`
and `Secure` as the session's cookies). It holds the account's id, a random nonce and the date, signed with an HMAC under a key
derived from `APP_KEY` and bound to the account's session key, so a new password, `AccountSessions.end()` and `endEveryone()` make
every earlier cookie worthless when the provider keeps a session key (with `null` the cookies survive, as do the sessions). The browser that
changed the password gets a new cookie from `auth.deviceCookie()`, and so does one that finishes a second factor after a typed password. `AUTH_DEVICE_COOKIE_DAYS` sets how long it lasts (default 90, `0` turns it off). With a valid cookie for
exactly the account found, an attempt does not count against the shared ceiling but against the cookie's own limit of ten an hour; past
it, the cookie counts as none until the hour is over. The limit per client always applies. A cookie that does not fit (none, forged,
expired, of another account, from before a new key) and an unknown account take the same path, and the answer does not tell which it
was. Set the cookie from your own login and reset controllers: `auth.deviceCookie()` after a successful `attempt()` and
`broker.deviceCookie(user)` after a successful `reset()` give the name, value and options (`ctx.cookies.set(device.name, device.value,
device.options)`); the starter kit's controllers do. A stolen cookie gives its thief ten guesses an hour on that one account, no
more than the thief of a session has.

Each refused attempt of the first kind dispatches a [`SignInLockedOut`](#events) with `scope: 'client'`; the account's ceiling dispatches
one with `scope: 'account'`, once per window. The starter kit's `QueueLockoutMail` listens for the second and queues the mail to
the owner. The route's own limit per client (`auth.login`, 30 a minute whatever the identifier) stays middleware; it counts apart from the
limits inside `attempt()`, so a failed sign-in is one attempt for each of them and none counts twice against the same limit.

A password reset, a new password or [an ending of every session](#ending-every-session-of-a-user) that lands while the password is
still being checked ends that sign-in too: `attempt()` answers `invalid-credentials`, like for a wrong password, and a new attempt
checks the new state.

The limit is counted before the password is checked, in one atomic step: guesses sent at the same moment cannot all slip under
it. Five failed attempts a minute for one address from one client lock it for the rest of the minute; a client is its IPv4
address or its IPv6 /64 ([`clientKey()`](rate-limiting.md#keys-and-the-clients-address)). The starter kit also puts an `auth.login`
limit on `POST /login`: 30 requests a minute from one client, whichever addresses they name. It counts every request, successful
sign-ins and validation failures included, so a CGNAT, a school or an office behind one address shares the 30 a minute. The number is
that of [the limits of the auth routes](#the-limits-of-the-auth-routes). The
[rate limiting](rate-limiting.md#defining-limiters) page covers limiters.

The starter kit's login page says, when the account's ceiling is reached: "Too many failed sign-ins for this account. Reset your
password or sign in with a passkey." Its `QueueLockoutMail` queues `SendLockoutMailJob` on the `SignInLockedOut` of that moment, and the job
mails the owner only when an account exists, so the mail is no oracle either.

A count is one cache entry per address tried, for addresses with and without an account, kept for a day (its key is an HMAC, so it
cannot be cut down). A public deployment keeps the counts in the `database` or `redis` cache store, not in `file`, and `cache:prune`
scheduled (see [cache](cache.md)), so a flood of made-up addresses does not pile up.

`signIn(user)` signs a user in without a password, for example right after a registration. It returns `'signed-in'`, or
`'two-factor-required'` for an account with a second factor: that account is not signed in, exactly as with `attempt()`. A
registration signs in a new account, which has no second factor, so its result needs no handling there. Both methods do the same
to the session:

- **A new session.** The session gets a new id and a new CSRF token, and keeps its data. An id handed out before the sign-in signs
  nobody in: this stops session fixation.
- **A fingerprint, not the key.** The session keeps an HMAC-SHA256 of the account's id and session key, under a key derived from
  `APP_KEY`, never the session key itself. Whoever reads the database cannot compute one, so a stolen copy of the table is no way into
  a session store. The password hash is not part of it, so a rehash at sign-in ends no session. Two accounts never share one, also
  without a key. **Rotating `APP_KEY`:** move the old key to `APP_PREVIOUS_KEYS`, and the fingerprints made under it stay valid; without
  it, every session and every remember-me token of every account ends once.
- **A fresh page.** The browser loads the next page in full, so no page kept in its memory from before the sign-in comes back. A
  sign-in by the remember-me cookie continues the same person's session and skips this.

### The limits of the auth routes

`@marmeon/auth` defines a rate limiter for every route of the starter kit's auth module, when its provider boots and `@marmeon/cache`
is there. Every request that changes something and that a guest can send carries `throttle()` with one of them, and so do four routes
for signed-in users (the passkey options, the verification mail and the change of address). They
come on top of the limits inside `attempt()`, `TwoFactor` and `Passkeys`, which count failures per account: these limit the requests,
before a session lock, a hash or a signature check costs anything.

| Limiter | Route | Limit |
| --- | --- | --- |
| `auth.login` | `POST /login` | 30 a minute per client |
| `auth.register` | `POST /register` | 10 a minute per client |
| `auth.password-reset-link` | `POST /forgot-password` | 5 a minute per client |
| `auth.password-reset` | `POST /reset-password` | 10 a minute per client |
| `auth.two-factor-challenge` | `POST /two-factor-challenge` | 10 a minute per client |
| `auth.passkey-sign-in-options` | `POST /passkeys/sign-in/options` | 30 a minute per client |
| `auth.passkey-sign-in` | `POST /passkeys/sign-in` | 10 a minute per client |
| `auth.passkey-challenge-options` | `POST /two-factor-challenge/passkey/options` | 10 a minute per client |
| `auth.passkey-challenge` | `POST /two-factor-challenge/passkey` | 10 a minute per client |
| `auth.passkey-confirm-options` | `POST /confirm-password/passkey/options` | 10 a minute per user |
| `auth.passkey-step-up-options` | `POST /settings/two-factor/verify/passkey/options` | 10 a minute per user |
| `auth.verification` | `POST /email/verification-notification` | 3 a minute and 10 a day per user |
| `auth.email-change` | `PUT /settings/email` | 6 a minute per user |

A client is its IPv4 address or its IPv6 /64 ([`clientKey()`](rate-limiting.md#keys-and-the-clients-address)); a limit never keys on
what the form sends. To change one, define a limiter of the same name in a provider's `boot()` of your own; yours replaces the default,
whichever boots first:

```ts
app.container.make(RateLimiter).for('auth.login', (ctx) => Limit.perMinute(60).by(clientKey(ctx.ip)));
```

The kit's controller also sends at most five verification mails an hour to one address. A route you add that changes something for guests needs
its own `throttle()`; nothing adds one for you. Replacing `auth.login` removes the protection against one client that tries many addresses, which
the limits inside `attempt()` do not give; keep a limit per client in your replacement.

## Signing out

`signOut()` signs the user out on this device. The session's data, its id and its CSRF token are all replaced, and the remember-me
token of this device is deleted:

```ts title="modules/auth/controllers/LogoutController.ts"
import { Auth } from '@marmeon/auth';
import { Controller } from '@marmeon/http';
import { Session } from '@marmeon/session';

export class LogoutController extends Controller {
  readonly #auth: Auth;
  readonly #session: Session;

  constructor(auth: Auth, session: Session) {
    super();
    this.#auth = auth;
    this.#session = session;
  }

  async handle() {
    const locale = this.#session.get('locale');
    await this.#auth.signOut();
    if (locale) this.#session.put('locale', locale);
    return this.redirect().route('auth.login');
  }
}
```

The language the visitor chose outlives the session it was stored in, because the controller puts it into the new one.

The response also tells the browser to forget the site's storage with `Clear-Site-Data: "storage"`, and
the next page loads in full. A sign-out from the client side answers `409` with `x-marmeon-location` and `x-marmeon-reload: history`:
that is the full reload, not an error. The other tabs of the same browser follow by themselves. The
[client features](client-features.md#the-browsers-storage-on-sign-out) page explains both, and how to keep the storage.

## How long a sign-in lasts

Every lifetime of a sign-in is listed here. The list of [sign-ins](#sign-ins) leaves out a sign-in whose lifetime is over.

| What | Default | What it ends | Assurance |
| --- | --- | --- | --- |
| The session cookie | Until the browser closes | The cookie in the browser, which has no `Max-Age`; the session on the server lives by the two rows below. | A browser that restores its session keeps it. |
| `SESSION_LIFETIME_MINUTES` | 120 minutes | A session that makes no request: the time since the last one. | `SESSION_LIFETIME_MINUTES=60` (at most an hour idle) is recommended for an app that needs AAL2 (ASVS 7.3.1). |
| `AUTH_SESSION_MAX_HOURS` | 24 hours | A sign-in, however active the user is. A valid remember-me cookie signs in again. | 24 hours is the limit NIST SP 800-63B-4 sets at AAL2. |
| `AUTH_REMEMBER_DAYS` | 30 days (0 to 30) | The [remember-me](#remember-me) cookie, counted from the sign-in that made it. | AAL1: a convenience, not a proof. |
| `twoFactor()` `maxAge` | 24 hours | The proof of a [second factor](two-factor-authentication.md#requiring-it); then the user is asked for it again. | AAL2 holds only on routes behind `twoFactor()`. |
| A change of factors | 15 minutes, no setting | The proof that [changing the factors](two-factor-authentication.md#changing-the-factors), the e-mail address or an API token asks for. | A factor proven within this time. |
| `AUTH_PASSWORD_TIMEOUT_SECONDS` | 15 minutes | The password or passkey confirmation of [sudo mode](#sudo-mode). | The password or a passkey; only a passkey also counts as a second factor. |

`SESSION_LIFETIME_MINUTES` is renewed by every request, so on its own an active session would never end. `AUTH_SESSION_MAX_HOURS` (1 to 720)
is the longest a sign-in lasts, however active the user is: a session signed in by password or passkey ends that many hours
after the sign-in, and the user types the password again. It matches the absolute lifetime of ASVS 7.3.2.
Sessions guests use are not affected.

A user who ticked "Keep me signed in" is not asked: when the limit is reached, a remember-me cookie that is still valid signs
the user in again in the same request, with a new limit. The session starts afresh, with new data, no old input and a new CSRF
token. A session restored this way never outlives its token, so the whole stay is bound by `AUTH_REMEMBER_DAYS`. That sign-in is
AAL1, not a re-authentication at AAL2: AAL2 holds on routes behind [`twoFactor()`](two-factor-authentication.md#requiring-it),
which asks for a fresh proof; a remember-me sign-in carries the time its token's second factor was proven, so such an area asks
again once that is older than its `maxAge`, whatever the new limit says. Confirming the password, a second factor or a new password does not move the limit.

A session that was open when the app was updated has no sign-in time: its limit starts with its next request, so an update signs
nobody out. A time the session holds that cannot be read, or that lies more than a minute in the future (servers whose clocks
differ), ends the sign-in. Once the limit is reached, requests that only read (islands) cannot sign in again: they see a guest
until the page's own request does.

## Remember me

Remember me is a convenience each user chooses, and the starter kit's checkbox is not ticked. It signs in without the password
and without a second factor of its own, so it counts as the lowest assurance level (AAL1), not as a proof.

`attempt(email, password, { remember: true })` keeps the user signed in on this device after the session has expired. It is the way
to stay signed in after a browser restart: the session cookie ends when the browser closes. The browser
gets a cookie, `marmeon_remember`, that is encrypted, `HttpOnly`, and `Secure` and `SameSite` like the session cookie. When cookies are `Secure` both cookies carry the `__Host-` prefix, which makes a browser refuse them unless they are `Secure`, have `Path=/` and no `Domain`. `rememberCookieName(authConfig, sessionConfig)` returns the name; only that name is read, never the bare one beside it. It is valid for
`AUTH_REMEMBER_DAYS` days from the sign-in (30 at most) and using it never extends it.

`AUTH_REMEMBER_DAYS=0` turns remember me off: `remember: true` still signs in, without a token or cookie, and the starter kit
hides the checkbox. No cookie signs in any more, and a cookie that is presented has its token deleted. The bound also holds for
tokens issued under a higher value: a token older than `AUTH_REMEMBER_DAYS` days is refused and deleted, even if its row says it
lasts longer. `marmeon auth:prune-tokens` (the starter kit schedules it daily) takes the token off every sign-in whose token expired
or is older than `AUTH_REMEMBER_DAYS` days, all of them with `0`, so raising the value again does not bring old tokens back. A value
above 30 stops the boot.

The cookie is consulted when the session has no user, and when the session's [sign-in has reached its limit](#how-long-a-sign-in-lasts). It holds a selector and a secret validator, and the token hangs on the row of its [sign-in](#sign-ins): the
`sign_ins` table keeps one row per browser, with the validator only as its SHA-256 hash, so a leaked table signs nobody in. The selector is a
`secret()` column as well, since whoever knows it can end the sign-in. A remember-me sign-in continues the row of its token, so one browser is one entry. Every app that has a `UserProvider`
has sign-ins and with them the remember-me token; the starter kit's migration creates the table, and `marmeon make:sign-ins-table` writes it for an app
that handles authentication itself (see [the columns](#sign-ins)).

A token is bound to the account state the sign-in verified: it stores the same fingerprint a session keeps (an HMAC of the
account's id and session key under a key derived from `APP_KEY`, never the key itself), and a cookie signs in only while the account still has that
fingerprint. A reset, a new password, a new session key or an ending of the account's sessions therefore refuses every token made
before it, even one a sign-in wrote a moment after the account changed. A refused token is deleted and the request is a guest, like
an invalid one. A token without a fingerprint is refused. The device that stays signed in when
`updateSessionKey()` changes the account keeps its token. A rehash during `attempt()` (new `HASH_*` costs,
say) changes the password hash and nothing the fingerprint is made of: no session and no remember-me cookie of the user's other
devices ends by it. A token made before the fingerprint left out the hash is refused once, like a token without a fingerprint.

- **Every use rotates the validator.** The cookie gets a new value, and the old one stops working. A second tab that sends the old
  value within 10 seconds of the rotation still passes.
- **A copied cookie ends every remember-me token and every session of the user.** An old validator that comes back later, even after
  the owner's browser has rotated several times since, means two browsers hold the same cookie, and the one that used it first already has a session. All of the user's sign-ins are
  deleted, their tokens with them, every session ends at its next request (see [ending every session of a user](#ending-every-session-of-a-user)), and
  the app logs a warning with the address and the browser of the request that presented the old cookie, and dispatches
  [`RememberTokenReused`](#events) so the app can tell the owner. The request that presented the old cookie is a guest. If the `UserProvider` cannot store a session
  key, ending the sessions fails: that is logged as an error, the event says `sessionsEnded: false`, and only the tokens are gone.
  A false alarm, such as a lost response after a rotation or a browser that restores an old cookie, signs the user out on every
  device.
- **A sign-in without "remember me" drops the cookie the browser already carried.** One token per device: the sign-in ends the sign-in of
  the cookie it finds, and the cookie goes with it. The list does not show a browser as kept signed in by a cookie that no longer
  works. This ends the row of another user too, on a shared browser: the cookie is replaced either way.
- **Requests that only read never use it.** An island cannot sign in: rotating the token there would hand the new value to no
  one. The next page request signs in.

The token is part of the sign-in store: to keep it somewhere else than the `sign_ins` table, bind your own [`SignInStore`](#your-own-stores), which
holds both. `issueToken(userId, id, { until, fingerprint })` hangs a token on a sign-in and returns the cookie value; it must
persist the fingerprint and hand it back from `consume()` (kept over every rotation), and a store that drops it makes every cookie useless.
`rebind(userId, cookie, fingerprint)` replaces it for the device that stays signed in; it checks the validator of the cookie like `consume()` does (the current one, or the previous one inside the grace window) and answers a `Result`: `err({ kind: 'stolen', userId, reused })` for a stale validator, after deleting the user's sign-ins, and `invalid` for an unknown row. `updateSessionKey()` then end every session of the account, as at a copied cookie, and keep no token. `consume()` returns the device: `userId`, the `signIn` the token hangs on, the rotated `cookie`, `expiresAt`, `createdAt` and the `fingerprint`. `createdAt` is when the token was made, kept over every rotation. A token made before the account's [second factor](two-factor-authentication.md#setting-up) was confirmed is refused by it. `createdAt` also sets the `AUTH_REMEMBER_DAYS` bound, and a missing or invalid one refuses every remember-me sign-in. `prune(window, rememberMaxAgeDays)` must take the token off the sign-ins whose token expired or was made that many days ago or earlier (every token with `0`) and delete the rows the list does not show. When an old validator comes back, `consume()` returns `err({ kind: 'stolen', userId, reused })` and must have deleted the user's sign-ins; deleting them and deciding which request reports are one atomic step (one `DELETE … RETURNING`, say), so that a failed statement deletes nothing and the next replay reports the theft again. The window that remains is a process that dies, or an `AccountSessions.end()` that fails (it is logged), between the deletion and ending the sessions: the sign-ins are gone, the sessions of the thief are not, until they expire. `reused: true` means the presented validator was the one just replaced by a rotation; it is information only. An older validator, or one that was never issued, presented with a known selector is a copy as well (the selector is random), and every `stolen` dispatches `RememberTokenReused`. Of parallel requests that present the old validator, only the one that removed the token reports `stolen`; the others get `invalid`. `remembered(cookie)` says whether the sign-in of a cookie still holds its token and must see an `end()` at once (no cache, no lagging replica): a sign-in by a remember-me cookie asks it right before it starts. `forgetToken(cookie)` ends the sign-in of a cookie, token and row.

## Sudo mode

Some pages ask for a confirmation again even though the user is signed in, such as the page with the API tokens.
`confirmedPassword()` lets a user through who typed the password, or proved a [passkey](passkeys.md#confirming-sudo-mode) with user
verification, within the last `AUTH_PASSWORD_TIMEOUT_SECONDS`, 15 minutes by default:

```ts title="modules/auth/routes.ts"
import { authenticate, confirmedPassword } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ConfirmPasswordController } from './controllers/ConfirmPasswordController.ts';
import { ShowAccessTokensController } from './controllers/ShowAccessTokensController.ts';
import { ShowConfirmPasswordController } from './controllers/ShowConfirmPasswordController.ts';
import { ConfirmedAddress } from './middleware/ConfirmedAddress.ts';

export default defineRoutes((Route) => {
  const confirmedAddress = Route.middleware(authenticate()).middleware(ConfirmedAddress).authorize(everyone); // the user's own account
  confirmedAddress.get('/confirm-password', ShowConfirmPasswordController).name('auth.password.confirm');
  confirmedAddress.post('/confirm-password', ConfirmPasswordController).name('auth.password.confirm.store');
  confirmedAddress.middleware(confirmedPassword()).get('/settings/tokens', ShowAccessTokensController).name('auth.tokens');
});
```

`ConfirmedAddress` is the starter kit's middleware: `verified()` while the registration is private. A page that creates API tokens
needs a confirmed address as well as the password, because a token outlives a password reset unless
`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`: an account registered with somebody else's address must never reach it. With open registration, use `verified()` there, as the
[API tokens](api-tokens.md#creating-tokens) page explains.

The password alone does not change the factors of an account that has [a second factor](two-factor-authentication.md#changing-the-factors): that needs a factor proven within 15 minutes as well ([how long](#how-long-a-sign-in-lasts)).

Everyone else goes to `auth.password.confirm`, and after the confirmation back to the page they asked for. A JSON client gets
`423 {"message":"Password confirmation required."}`. `confirmedPassword({ confirmRoute, maxAge })` names another page or another
time, a [`Duration`](time.md#spans-of-time) (`{ minutes: 5 }`; a number is seconds). The resolved `AuthConfig` carries the
variables as `passwordTimeoutSeconds`, `resetMinutes`, `resetThrottleSeconds` and `emailChangeThrottleSeconds`; the unit is in the name.

In your own code, `auth.passwordRecentlyConfirmed(within?)` answers the same question for the current session: `true` when a password or a passkey was confirmed inside the sign-in and within `within`, a [`Duration`](time.md#spans-of-time) (default `AUTH_PASSWORD_TIMEOUT_SECONDS`). A session with no usable confirmation time is `false`, never `true`.

The confirmation page posts the password to `auth.checkPassword(password)`, which checks it and notes the time. A right password also
gives the session a new id (its data stays, and so do the counts of the password checks): a session id that leaked before the
confirmation does not reach the window it opens. A client that sends cookies back, as a browser does, follows on its own; a test
that holds a session cookie in a variable takes the new one from the response (`response.cookie(...)`). What an app notices: live
streams that other tabs of the browser hold end until the tab navigates, and a request that still carries the old cookie (a double
submit, a parallel `fetch`) is a guest. It answers a
`Result`: `ok`, or `invalid-password`, or `throttled` ([below](#how-password-checks-are-counted)). For a user without a password it takes as long and answers
`invalid-password`. A user with a passkey can confirm with it instead:
[`passkeys.confirm()`](passkeys.md#confirming-sudo-mode) notes the time the same way, and a [passwordless sign-in](passkeys.md#passwordless-sign-in)
counts as a fresh confirmation, since the passkey was proven just now. `attempt()` notes the time as well (for an account with a
second factor, dated when the password was typed, not when the factor was proven); `signIn()` does not, since nobody proved anything, and it forgets a
confirmation noted before: the new sign-in starts outside sudo mode, even over the session of the same account, and proving a
second factor afterwards does not change that. A confirmation counts only inside the sign-in it was given for.

A confirmation is enough to reach a page, but not for every action. What lets whoever holds the session stay in the account after the
owner has recovered it asks for the **current password in the same form**, whatever confirmed sudo mode, such as: changing the e-mail
address, creating an API token, registering, releasing or removing a passkey, turning two-factor authentication on or off
(`TwoFactor.confirm(code, password)`, `disable(password)`, which answers a `Result` like `checkPassword()`; `confirm()` checks the password before the code, so only whoever knows it spends the code budget), making new recovery codes (`regenerateRecoveryCodes(password)`) and changing the password. A passkey alone can confirm sudo mode, so without that second question a hijacked session could add a way in that
survives the owner's recovery.

Every `confirmedPassword()` route is reachable with a passkey alone, the reading ones too (a data export) and those that end or rename something else (ending another sign-in, renaming a passkey). Whatever creates a way into the account asks for the password in its form, as above; add that question to your own routes of the same kind.

A confirmation or a proven second factor dated up to a minute ahead of this server's clock still counts, so that a cluster whose clocks differ by a little does not send a user back to the confirmation page. Anything further ahead does not count, and the window is counted from the time the confirmation carries, so one dated ahead lasts at most a minute longer than the window above; a confirmation dated in the past is never valid for longer.

An account with neither a password nor a passkey, such as one created by a sign-in link or by an OAuth provider your app wrote, has
no way to confirm sudo mode yet: `confirmedPassword()` never lets it through.

### How password checks are counted

`checkPassword()` counts every check of a signed-in user's password, before it is made, and a held-up check is answered without hashing the password. The checks are counted for each sign-in (five a minute and twenty an hour, a right password clears the minute) and, for a sign-in that did not begin
with a typed password, also for the account (twenty an hour across all such sign-ins). The starter kit's confirmation, password change, "sign out other
devices", e-mail change and new API token call it, and `TwoFactor` and `Passkeys` call it for their own password checks. A stolen session must not become a way to guess the password, and a passkey-only session
that uses up the account's count must not lock out the owner, who typed the password to sign in: the account's hourly count never applies to a sign-in made by `attempt()`.
On top of both, one generous cap holds for every sign-in of the account, typed or not: 100 checks a day. Stolen sessions cannot add up their own limits past it, whatever `AUTH_SESSION_MAX_HOURS` allows. It too answers `throttled` with `account: true`.
When the account's count is what holds a check up, `checkPassword()` answers `throttled` with `account: true`, and the starter kit then says how long to wait and that signing in again with the password lifts the hourly part of the count, not the daily one. An empty password is `invalid-password` and counts nothing, since there is nothing to guess.

No method of `Auth` checks a password without counting. `checkPassword()` answers a `Result`, which is an object even for a wrong password: test `.ok`, never its truthiness. `auth.passwordCheckScope()` says whose checks these are (the sign-in's own random key, which a new session id within the sign-in keeps, and whether it began with a typed
password); for a secret of your own that a signed-in user types, `takePasswordCheck(limiter, scope, userId)` counts one and returns the seconds to wait, and `clearPasswordCheck()` clears the minute after a right one.

The counts live in the app's `RateLimiter`, so signing in needs `@marmeon/cache` with its provider registered. An app that has a `UserProvider` and no limiter stops at boot with error A7.

## Changing the password

`updatePassword(password)` stores a new hash for the signed-in user, together with a new session key. The key is what ends sessions:
the hash is not part of the fingerprint a session keeps, so this session is bound to the new key and stays signed in. Every other session ends at its
next request, every other sign-in of the user is deleted and this device's remember-me token is taken off, and `PasswordChanged` is dispatched. With
`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, every API token of the user is revoked as well, in the same transaction as the new
hash, and the log says how many. A new password also deletes the account's password-reset link, so a link mailed before it cannot set another one.

`updatePassword()` does not check the current password itself, but it throws without a recent confirmation, a password or a passkey
(`passwordRecentlyConfirmed()`, as `endSignIn()` does): a stolen session cookie behind a route with only `authenticate()` cannot
take the account over by choosing a password. The controller checks the current password first, as the starter kit's does, with
`checkPassword()`, which is that confirmation; a route behind [`confirmedPassword()`](#sudo-mode) has it already, as long as the confirmation is within `AUTH_PASSWORD_TIMEOUT_SECONDS` (`updatePassword()` checks that window, not a longer `maxAge` of the middleware):

```ts title="modules/auth/controllers/UpdatePasswordController.ts"
import { Auth, password, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { passwordCheckMessage } from '../password-errors.ts';

export const UpdatePasswordRequest = defineRequest({
  schema: r.object({ current_password: r.string().required().max(4096), password: password(), password_confirmation: r.string() }).confirmed('password'),
});

export class UpdatePasswordController extends Controller {
  static request = UpdatePasswordRequest;

  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdatePasswordRequest> & Authenticated) {
    const checked = await this.#auth.checkPassword(ctx.body.current_password);
    if (!checked.ok) throw new ValidationError({ current_password: [passwordCheckMessage(this.#translator, checked.error)] });
    await this.#auth.updatePassword(ctx.body.password);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.password_changed') });
  }
}
```

`passwordCheckMessage()` in `modules/auth/password-errors.ts` turns the error into the text of the field: the wrong password, the wait, or the
request to sign in again. The handler's
`& Authenticated` types the context: `ctx.user` is there because the route sits behind `authenticate()`. The
[hashing](hashing.md#the-password-rule) page explains the `password()` rule.

To sign out every other device with the password, without changing the password or its hash, check it and then call
[`updateSessionKey()`](#signing-out-other-devices-without-a-password), as the starter kit's controller does:

```ts
const checked = await this.#auth.checkPassword(ctx.body.password);
if (!checked.ok) throw new ValidationError({ password: [passwordCheckMessage(this.#translator, checked.error)] });
await this.#auth.updateSessionKey();
```

The other sessions end at their next request, and the remember-me tokens of the other devices are deleted.

The starter kit runs both routes with `.block()`: one such request per session at a time. Two at once could leave the session
with the fingerprint of the other request's key, and sign it out. The [session](session.md#requests-that-must-not-overlap) page
explains `block()`.

### Signing out other devices without a password

An account that signs in by a link or through another provider has no password to check. `updateSessionKey()` signs out its other
devices all the same: it draws a new random session key, stores it with `updateSessionKey(id, key, expected)` of your `UserProvider`, and
gives this session the new fingerprint. The other sessions end at their next request with every session driver, and the
remember-me tokens of the other devices are deleted. It works for accounts with a password too.

`updateSessionKey()` asks for no recent confirmation, because the app may have confirmed the user its own way (a link, OAuth). Where
the account has a password, call it after `checkPassword()` or behind `confirmedPassword()`; behind `authenticate()` alone, a stolen
session cookie could sign its owner out everywhere else.

The key is a column of the account. Mark it secret, so that `Row<'users'>` and every query that selects all columns leave it out:

```ts title="modules/auth/migrations/2026_10_10_120000_add_session_key_to_users_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('users', (table) => table.string('session_key', 64).nullable().secret()),
  down: (schema) => schema.alter('users', (table) => table.dropColumn('session_key')),
});
```

Your provider stores the key and hands it back as `sessionKey` from `findById()` and `findForSignIn()`. A secret column is read
only with `secret()`, as the starter kit's `UserRepository` reads the password hash. Its parts that signing in needs, with the
session key added:

```ts title="modules/auth/UserRepository.ts"
import { credentialWriter, type Credentials, type PasswordHash, type UserProvider } from '@marmeon/auth';
import { Repository, secret } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  findForSignIn(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  updatePasswordHash(id: number, hash: PasswordHash, options?: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null }): Promise<boolean> {
    return credentialWriter(this.db).updatePasswordHash(id, hash, options);
  }

  updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    return credentialWriter(this.db).updateSessionKey(id, key, expected);
  }

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query.selectAll().select((eb) => [secret(eb, 'password'), secret(eb, 'session_key')]).executeTakeFirst();
    if (!row) return undefined;
    const { password, session_key, ...user } = row;
    return { user, passwordHash: password as PasswordHash, sessionKey: session_key };
  }
}
```

`User` is `Row<'users'>` in the starter kit's `users.ts`: the secret columns are not part of it.

`updateSessionKey(id, key, expected)` must answer `true` when `key` equals the stored key and `expected` matches it: setting up a second
factor calls it with the same key twice to lock the account's row until the factor is stored. A provider that skips writes that change
nothing, or counts only rows whose value changed, must still return `true` there; otherwise `confirm()` and `register()` throw an error that names this rule.

`updateSessionKey()` checks nothing itself: confirm the user your own way first, such as with a fresh link. A provider has to
implement `updateSessionKey()`; one that lacks it at run time (JavaScript, a cast) makes the call throw error A5 that names the method.
It throws as well when `findById()` does not hand the new key back, or when `updateSessionKey()` of the provider does not answer with
a boolean. It never leaves the other devices signed in while it seems to have worked.

The write is a compare-and-set because a request can run while the sessions of the account are being ended
(`AccountSessions.end()`, or another device calling this). Such a request must not bind its session to the key it did not check.
`updateSessionKey()` returns `true` when it replaced the key, and `false` when another request had replaced it first: this session
was ended meanwhile and is signed out now. `AccountSessions.end()` passes `undefined` as `expected`: it writes regardless of the stored key, so
no request can keep it from ending the sessions. Use `undefined` for nothing else. The same holds for `updatePassword()`: it anchors the
session to what the request verified, so a session that was ended meanwhile ends at its next request.

```ts title="modules/auth/controllers/SignOutOtherDevicesController.ts"
import { Auth, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

export class SignOutOtherDevicesController extends Controller {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }

  async handle(_ctx: HttpContext<Authenticated>) {
    await this.#auth.updateSessionKey(); // false: this session was ended meanwhile, and the next request is a guest's
    return this.back('/settings/security');
  }
}
```

Run such a route with `.block()` as well. For an account with a password, ask for it first with `checkPassword()`, as
[above](#changing-the-password). An account whose key is still `null` has the id alone in its fingerprint until a new password or a sign-out of the other
devices writes a key.

### API tokens

A new password revokes the user's API tokens only with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, and "sign out other devices"
never does. Otherwise a token stays valid until it expires or is revoked on the tokens page. The
[API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains when to turn it on.

## Changing the address

`EmailChange` decides what is a matter of security when a signed-in user asks for a new address, and leaves the writing of the address
and the mail to your app, which owns the `users` table. It is opt-in: bind a store first,
`container.singleton(EmailChangeStore, DatabaseEmailChanges)`, or building `EmailChange` fails with K1. Ask for it in a controller:
```ts
const result = await this.#emailChange.request(ctx.body.email, ctx.body.current_password, {
  // Private registration (the default): put the link in the mail. Called inside the transaction that stores the change.
  deliver: async ({ userId, email, token }) => {
    await this.#queue.dispatch(SendEmailChangeMailJob, { user: userId, email, token });
  },
  // `AUTH_PRIVATE_REGISTRATION=false`: write the address at once, unconfirmed.
  apply: (userId, email, verifiedAt) => this.#users.applyEmailChange(userId, email, verifiedAt),
});
if (!result.ok) {
  // `invalid-password` and `throttled` as for `checkPassword()`, or `duplicate` (only without private registration)
}
```
`apply` answers `ok(user)`, or `err({ kind: 'duplicate' })` when another account has the address and `err({ kind: 'missing' })` when the
account is gone. The link opens a route that calls `confirm(linkUserId, token, apply)` with the account named in the URL and the token;
`verifiedAt` is then the time of the click.

What `EmailChange` decides, so that your controllers do not have to:

- **A fresh factor.** `request()` throws on an account that has a second factor unless this session proved one within fifteen
  minutes. Put the route behind `confirmedSecondFactor()`; the check is repeated in the service, so a route added by hand cannot skip it.
- **The password, throttled.** `request()` checks the password with `checkPassword()`, so a wrong one is counted like every other
  [password check](#how-password-checks-are-counted) and the `err` is its (`invalid-password`, `throttled`). A passkey alone can confirm
  sudo mode, and a hijacked session must not take the account over by changing the address and then resetting the password.
- **The same answer for every address.** With private registration, `request()` stores the change and calls `deliver` in one transaction,
  whether the address is free or belongs to another account, and never asks. If `deliver` throws, nothing is stored. Your mail job
  decides what the owner of a taken address is sent.
- **One link a minute.** A right password clears the password throttle, so a loop of valid requests would otherwise mail any address from
  your domain. After a request that sent a link, the account waits `AUTH_EMAIL_CHANGE_THROTTLE_SECONDS` (60 seconds by default, `0` turns it off);
  a request inside the pause gets the same answer, `{ pending: true }`, and sends and stores nothing. A user who typed a wrong address
  asks again after the pause. A request that stored and sent nothing (the mail could not be handed over, the session had ended) gives the pause
  back. Without private registration there is no pause: the address is written at once, and your app throttles the confirmation mail it sends
  for it (`throttle()` on the route, or a limiter of your own).
- **One link, used once.** The token is stored only as a SHA-256 hash, expires after `AUTH_EMAIL_CHANGE_MINUTES` (60 by default, 5 to
  1440), and a request for another address replaces the older one. `confirm()` claims it and calls `apply` in one transaction, so a write that fails
  leaves the link usable. If another account took the address meanwhile the answer is `taken` and the link is spent all the same.
- **Only for the account it names.** `confirm()` answers `wrong-account` when another user is signed in, and keeps the link for the right
  one. The store also keeps the session key the request was checked against, so a link ends when the sessions of the account are ended or
  its password changes (see [the stores](#your-own-stores)).
- **Without private registration** `request()` writes at once with `verifiedAt` `null`, `duplicate` is the `err`, and `confirm()` answers
  `not-found`: there are no links. The write happens only while the session still fits the account; otherwise the session ends and
  `request()` throws.
- **The token is a secret.** The job that mails the link carries it in its payload, and `jobs` is a table: make the job
  `static readonly encrypted = true` (see [queues](queues.md#secrets-in-payloads)), and keep the token out of logs.
- **Your own transaction.** `confirm()` runs in a transaction of its own. Called inside one of yours, a `taken` answer rolls the spent link
  back with it, so the link works again; return the `err` after your transaction has committed.

The old address should be told. `EmailChanged` (`userId`, `previousEmail`, `email`) is dispatched once the address is written, by
`confirm()` and by `request()` without private registration; a listener sends the note:
```ts
export class NotifyAboutNewAddress {
  readonly #mailer: Mailer;

  constructor(mailer: Mailer) {
    this.#mailer = mailer;
  }

  async handle(event: EmailChanged): Promise<void> {
    if (event.previousEmail !== null) await this.#mailer.queue(new EmailChangedMail(event.previousEmail, event.email), { queue: 'mail' });
  }
}
```
The module registers it with `listeners: [listen(EmailChanged, NotifyAboutNewAddress)]`.

`cancel()` drops the signed-in user's own pending change, and `waiting()` tells the address that waits and its expiry (or `undefined`), for
a page that shows it. `EmailChange` is built per request, because it needs the session, so a queue worker cannot use it: the mail job asks
the `EmailChangeStore` instead, `store.pending(userId, email, token)`, which answers the expiry while the change is still that one and
`undefined` once it was replaced, used or dropped, so that a link is not sent for a change that no longer stands. A request for the
address that already waits leaves the change and its link as they are: `deliver` is not called and the answer is the same. `confirm()` answers one of `not-found`, `wrong-account`, `invalid` (unknown, used, expired, replaced or
`apply` answered `missing`) and `taken`. The route that opens the link needs a signed-in user and throws without one.

## Ending every session of a user

A session signs in with a fingerprint of the account, its id and session key, and every request compares it with
the account as it is now. When the session key changes anywhere, every other session stops matching and ends at its next request:
a new password and a reset write a new key with the hash, so they end the sessions too, and a rehash of the password at sign-in
does not. A password hash written without a key ends nothing. When the user is deleted, the lookup
finds nobody, and the session ends the same way. A request that only reads, such as an island, treats such a session as a guest
and leaves the ending to the next page request. The account's open live streams close at once and their browsers are checked when they connect again ([real-time updates](realtime.md#following-a-channel)).

> [!WARNING]
> A password hash you write yourself ends no session. An admin tool, a script or a test that sets `password` directly leaves every
> sign-in of the account alive. Write a new session key with the hash (`updatePasswordHash(id, hash, { sessionKey })`, as
> `updatePassword()` and the password reset do), or call `AccountSessions.end()` after it. Raising the `HASH_*` costs signs nobody out;
> to end every sign-in, run `marmeon auth:end-all-sessions --force`.

`AccountSessions` of `@marmeon/auth` ends every session of an account, and every remember-me cookie, API token and reset link with them. Use it after an
incident, from a command, a job or an admin controller. Put the route behind `authenticate()` and decide who may call it with `authorize(can(…))`, such as with a policy of your own:

```ts title="modules/admin/routes.ts"
Route.middleware(authenticate()).authorize(can(AdminPolicy, 'endSessions')).post('/admin/users/:id/end-sessions', EndSessionsController);
```

```ts title="modules/admin/EndSessionsController.ts"
import { AccountSessions, type Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';

export class EndSessionsController extends Controller {
  readonly #accounts: AccountSessions;

  constructor(accounts: AccountSessions) {
    super();
    this.#accounts = accounts;
  }

  async handle(ctx: HttpContext<Authenticated, { id: string }>) {
    const id = Number(ctx.params.id);
    if (!Number.isSafeInteger(id)) abort(404);
    const ended = await this.#accounts.end(id);
    if (!ended.ok) abort(404);
    return { removed: ended.value.removed };
  }
}
```

`end(id)` answers `missing` for an id that is no account (and for one that is not a valid id, such as `NaN` or an empty
string), and writes nothing then. Otherwise it goes in four steps, in this order:

1. It ends every sign-in of the account, remember-me tokens with them, so no cookie signs in again, and a remember-me sign-in that is running
   finds its token gone.
2. It stores a new session key with `updateSessionKey()` of your `UserProvider`. The fingerprint of every session changes, so each
   one ends at its next request, with every driver.
3. It deletes the sessions a store can find at once (only `database`, by its `user_id` column) and returns how many: `removed`.
4. It revokes the account's API tokens and returns how many: `accessTokens`; then it deletes the account's password-reset link and its pending change of address. The reset store
   does not say whether a link existed, so the result has no count for it.

| After `end(id)` | |
| --- | --- |
| Ended | sessions, sign-ins, remember-me tokens, API tokens (not with `{ accessTokens: false }` or `--keep-api-tokens`), the reset link, a pending change of address |
| Kept | second factors, passkeys |

A token that must outlive the call, such as an integration that keeps running after a sign-out, stays with `end(id, { accessTokens: false })`.
The framework passes that itself where it ends sessions on a suspicion (a remember-me cookie used twice, a passkey that looks copied) and
in `auth:reset-two-factor`, since a suspicion is no proof and an owner's integrations would stop for it. The second argument is an object; `end(id, false)` throws.

The session key is what ends the sessions, so your `UserProvider` must store one: a provider without `updateSessionKey()` does not
compile, and at run time `end()` throws error A5 before it changes anything, and names what to add. It also throws when `findById()` does not hand the new key back; the
sign-ins are gone by then. The starter kit's accounts have a `session_key` column. A request that is running while `end()` replaces the key cannot bind its session to the new state, so it is signed out as well; Inside a database transaction `end()` throws: each step commits on its own, and a rollback would bring the deleted tokens back.

A custom `SignInStore` needs `remembered(cookie)`, which says whether the token of a cookie is still stored and must see an `endAll()` at once (no cache, no lagging replica), or a session survives `end()`; a sign-in by a
remember-me cookie asks it right before it starts. A store without `endAll()` (JavaScript, a cast) makes `end()` throw error A6 before it changes anything.

`@marmeon/auth` brings this as a command, `marmeon auth:end-sessions <identifier> --force` (the identifier as your sign-in form normalizes it; the account is found by `UserProvider.findForSignIn()`), for an operator who has no admin page.
It prints how many stored sessions it deleted at once (the others end at their next request), how many API tokens it revoked and that it deleted the reset link,
and what it kept (second factors and passkeys, and the API tokens with `--keep-api-tokens`). It requires `--force` in every environment,
exits with 1 for an unknown identifier, and shows an error of the call instead of hiding it. The password still signs in, so change it first when it may be known.

`UserSessions` of `@marmeon/session` is the low-level variant, and deleting an account needs it. The starter kit's
`AccountDeletion` calls it after the account is gone. It does not touch remember-me cookies, which sign the user in again, so use
`AccountSessions` for an account that stays:

```ts title="modules/auth/AccountDeletion.ts"
import { PasswordResetTokenStore } from '@marmeon/auth';
import { Connections } from '@marmeon/database';
import { UserSessions } from '@marmeon/session';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';

export class AccountDeletion {
  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #resets: PasswordResetTokenStore;
  readonly #sessions: UserSessions;

  constructor(connections: Connections, users: UserRepository, resets: PasswordResetTokenStore, sessions: UserSessions) {
    this.#connections = connections;
    this.#users = users;
    this.#resets = resets;
    this.#sessions = sessions;
  }

  async delete(ids: readonly number[]): Promise<User[]> {
    const deleted = await this.#connections.transaction(async () => {
      const users = await this.#users.deleteAccounts(ids);
      for (const user of users) await this.#resets.forget(user.email);
      return users;
    });
    for (const user of deleted) await this.#sessions.end(user.id);
    return deleted;
  }
}
```

The starter kit's own version also dispatches `AccountDeleted` for other modules inside the transaction. Use it for every deletion
of an account, such as a "delete my account" page: `accounts.delete([user.id])`.

`UserSessions.canEnd()` tells whether the store is one of these. `UserSessions.end(id)` returns how many sessions it ended. Only the `database` driver can find a user's sessions, by the `user_id` column of its
table, and removes them. The other drivers cannot tell whose a session is, so `end()` returns `0` there: for a deleted account
that does no harm, since its sessions end at their next request. For a user who still exists, a new fingerprint ends the other
sessions with every driver: a new password or `updateSessionKey()`. `UserSessions.end(id)` ends every session of a user at once, the current one included, and only with the `database` driver.

## Ending every session of every account

After a leak, such as a copy of the database, a leaked `APP_KEY`, a compromised admin account or cookies stolen in bulk, every
sign-in that exists must end at once. An operator runs one command, and every app has it:

```sh
marmeon auth:end-all-sessions --force
```

From code, such as a job or an admin controller, `AccountSessions.endEveryone()` does the same. Guard the route as you would
[`end()`](#ending-every-session-of-a-user):

```ts
const ended = await this.#accounts.endEveryone(); // { accounts, resetTokens, accessTokens, signIns }
```

It also revokes every API token and deletes every password-reset token, since a thief who held a session may have created either.
`--keep-api-tokens` and `--keep-reset-tokens` (`accessTokens: false`, `resetTokens: false`) leave them, and the output names what was
kept. The old `--api-tokens` and `--reset-tokens` are refused with a hint, and nothing is ended.

The command takes no arguments (a mistyped `auth:end-sessions <identifier>` is refused, not widened), prints the environment it runs
in, and logs the operator and the host. `--force` is required in every environment, since it cannot be undone.

| | Ended |
| --- | --- |
| Sessions of every driver, on every instance | At their next request. No restart or deploy is needed. |
| Pending second-factor steps, password and second-factor confirmations | With the session they live in. |
| Sign-ins and their remember-me tokens | All deleted. |
| Password-reset tokens | All deleted, unless `--keep-reset-tokens` (`resetTokens: false`). |
| API tokens | All revoked, unless `--keep-api-tokens` (`accessTokens: false`). |
| Open live streams | Closed at once, in every process; each browser that connects again is checked and, signed out, is told to stop. A guest's stream stays. See [real-time updates](realtime.md#following-a-channel). |

Passwords stay, so change them where a hash may have leaked. Reset links are stored as hashes, but a link that was mailed before
the leak would work until it expires, which is why the command deletes them. After a leaked `APP_KEY` the command is the first step, not the
whole answer: the leaked key can also forge cookies, signed URLs and live and upload tokens. Set a new `APP_KEY` and leave the leaked
one out of `APP_PREVIOUS_KEYS` (the procedure of [rotating the key](encryption.md#rotating-the-key) without its first step). That stops
the forgeries, but it signs everybody out, and it makes two-factor secrets (reset them with `auth:reset-two-factor`), queued encrypted jobs and
sealed session data unreadable. Encrypted columns that were already copied stay exposed.

The command does not touch what a thief with a live session may have added, and its output says so:

| | After the command |
| --- | --- |
| Passkeys | Not touched. Check `PasskeyRegistered` events since the leak. |
| Second factors (TOTP, recovery codes) | Not touched. Check `TwoFactorEnabled` and `RecoveryCodesGenerated`, and run `auth:reset-two-factor` for a suspect account. |
| Passwords, e-mail addresses, pending e-mail changes | Not touched. Check for address changes since the leak, and change passwords where a hash may have leaked. |
| Accounts of another user provider | Not ended: `AccountSessions` covers the accounts of the bound `UserProvider` only. End those yourself. |

### How it works

The fingerprint of a session includes the account's session key, and every request compares it with `findById()`. The call writes
one fresh random key into every account with a single `UPDATE`, so every session stops matching at its next request, whatever
its driver. The fingerprint includes the account's id, so two accounts never share one though the key is the same. The
statement locks the rows of the user table until it finishes, which is acceptable for an emergency.

The order is fixed: the sign-ins first, remember-me tokens with them, so that no cookie signs in again once a later step fails; then the keys; then
the sign-ins once more, for one that a running sign-in made in between, then the reset tokens and the API tokens, unless kept. The key is written to every row, so a second factor
that is being stored at that moment is refused. The call throws, naming the remedy and before anything is deleted, when the
`UserProvider` or a store it will use lacks its method, and inside a database transaction.

A step that fails stops the call. The message, printed by the command with exit code 1 and logged, names the step, what was
already done, and whether the keys are rotated: if they are, every session is ended and only the clean-up remains. Run it
again: each step deletes or overwrites everything, so a second run is safe and finishes the rest. If the keys were written but the read-back
could not confirm them, the message says "fix the UserProvider, then run it again": a plain rerun fails the same way, so fix `findById()` first.

After the write, `AccountSessions` reads one account back with `findById()` and throws unless its `sessionKey` is the new key.
`findById()` must therefore return the `session_key` column as `sessionKey` straight from the database, with no cache and no lagging
replica. A cache would fail the read-back; a cache or replica that only some lookups hit slips past it and leaves those sessions live.

A `UserProvider` of your own writes `updateEverySessionKey()` too, and a store of your own the methods that delete every row:
[what your app implements](#what-your-app-implements) says how.

`AccountSessions` covers the accounts of the bound `UserProvider`; accounts in another table with their own provider are not ended.

`auth:prune-tokens` deletes only what expired; it ends no valid sign-in.

## Sign-ins

Every app with a `UserProvider` keeps one row per browser a user is signed in on, so the user can see them and sign out of one. The remember-me
token of a browser hangs on the same row. The default store, `DatabaseSignIns`, is bound by the auth package, on the `sign_ins` table: the
starter kit's migrations create it, and an app that handles authentication itself writes the migration and runs it:

```sh
pnpm marmeon make:sign-ins-table
pnpm marmeon migrate
```

`make:sign-ins-table` is `marmeon publish @marmeon/auth`: it writes into the `system` module, or the module `--module` names, and
nothing when your app has the migration already (the starter kit keeps it in its `auth` module). It ends with exit code 0 then.

`/up/ready` is red until the table has every column below, and the selector and validators carry the `secret()` mark.

A row is the authority over its sign-in. The session carries only the row's random id (128 bits), and every request checks that the row
is still there, with every session driver: a session whose row is gone ends at its next request, and so does its remember-me cookie,
which hangs on the same row. That is the end of a single session ASVS 7.5.2 asks an app to offer.

| Column | What it holds |
| --- | --- |
| `id` | 22 characters of base64url, the only thing the session stores. |
| `user_id` | The account; the rows go with it (`cascadeOnDelete()`). |
| `user_agent` | The browser's `User-Agent`, cleaned of control characters and cut to 255 characters. |
| `remember_selector` | The selector of the browser's [remember-me](#remember-me) token, unique, or `null` (a `secret()` column: whoever knows it can end the sign-in). |
| `remember_until` | When the token ends, or `null`. |
| `remember_validator_hash`, `remember_previous_validator_hash` | The SHA-256 of the cookie's validator, and of the one a rotation replaced (accepted for 10 seconds, for a second tab), or `null`; `secret()` columns. |
| `remember_rotated_at`, `remember_created_at` | When the validator was last rotated and when the token was made (kept over rotations), or `null`. |
| `remember_fingerprint` | The fingerprint of the account state the token was issued under, or `null`. |
| `signed_in_at` | The sign-in, or the sign-in by remember-me cookie that continued the row. |
| `last_seen_at` | The last request, exact to 5 minutes: it is written at most that often, so most requests write nothing. |

No IP address is stored. A list of places needs a lookup of the address, and a table of addresses is personal data that nothing else in
the framework needs. An app that keeps an audit log takes the address from the [`SignedIn` event](#events), which carries `ip` and
`userAgent`.

### Listing and ending sign-ins

`auth.signIns()` returns the browsers of the signed-in user: the current one first, marked `current`, then the others by last request.
Each entry has `id`, `current`, `remembered`, `signedInAt`, `lastSeenAt`, `createdAt`, `userAgent` and `device`. `device` is what
`describeDevice()` makes of the `User-Agent`: `{ browser, system }`, each `undefined` when it is not a known one, so the page words it
in its own language. It is a guess and a client can write what it likes in the header.

The list leaves out a sign-in whose session is over: one that has been idle longer than `SESSION_LIFETIME_MINUTES` or began longer ago than
`AUTH_SESSION_MAX_HOURS`, unless a valid remember-me cookie keeps it (`remembered`). Those rows stay in the table until
[pruned](#pruning-sign-ins).

`auth.endSignIn(id)` signs the user out of one of them. It returns a `Result`: `missing` for an id that is unknown, malformed or
another user's (the same answer for all three), and `current` for the browser that asks, which signs out with `signOut()`. The route
must be behind [`confirmedPassword()`](#sudo-mode): without a recent confirmation (a password or a passkey) `endSignIn()` throws, because a stolen session
cookie must not be able to sign its owner out everywhere else. An account with neither a password nor a passkey cannot end a
sign-in yet.

```ts title="modules/auth/controllers/EndSignInController.ts"
import { Auth, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

export class EndSignInController extends Controller {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }

  async handle(ctx: HttpContext<Authenticated, { signIn: string }>) {
    // `missing` (unknown, malformed or another user's) and `current` (this browser: `signOut()` is its way out) end nothing;
    // the page lists what is left either way.
    await this.#auth.endSignIn(ctx.params.signIn);
    return this.back('/settings/security');
  }
}
```

```ts title="modules/auth/routes.ts"
Route.middleware(authenticate()).authorize(everyone).middleware(confirmedPassword()).post('/settings/sign-ins/:signIn/end', EndSignInController).name('auth.sign-ins.destroy');
```

A page shows `await auth.signIns()` with a button per entry that is not `current`.

### What else ends rows

The rows of the other devices are deleted wherever the other devices are signed out, so the list never shows a browser that has
been signed out already:

- `signOut()` ends the row of this browser, and a sign-in over another sign-in ends the row it replaces.
- A new password with `updatePassword()` (which needs a recent confirmation) and `updateSessionKey()` end the rows of every other device, tokens with them, and keep the
  current one (a new password takes its token off, since the user typed the password again). The rows go before the new key or hash is stored, in the same transaction for a password: if a store
  cannot end them, nothing is changed and the call throws, because a token that survives would sign the other device in again.
- A password reset ends every row of the user, since it has no session of its own to keep.
- Each of these also closes the account's open live streams, after the commit of the request's transaction.
- [`AccountSessions.end()`](#ending-every-session-of-a-user) ends every row of the user.
- A copied remember-me cookie ends every row of the user, as it ends all their sessions. A token refused for its age (`AUTH_REMEMBER_DAYS`) or for predating the second factor takes its row with it. A token past its end is only taken off its row, which stays while its session lives; a row ended from the list takes its token with it.

`UserSessions.end()` alone does not touch the rows.

### Pruning sign-ins

A row of a browser that never came back stays in the table. `marmeon auth:prune-tokens` deletes exactly the rows the list does not
show, for every user, and takes expired tokens off their rows; its output counts the rows. It uses `SESSION_LIFETIME_MINUTES`
and `AUTH_SESSION_MAX_HOURS`, so it is the one command to schedule.

### Testing

`actingAs()` writes the session again with every request, so it cannot stand for a browser that stays signed in. A test signs in
twice with the real form and sends each session cookie back, ends one row through the `SignInStore`, and checks that browser's next
request. `cookieNames(app)` returns `{ session, remember }`, the names of the two cookies, with the `__Host-` prefix when the app's cookies are `Secure`:

```ts title="modules/auth/sign-ins.test.ts"
import { SignInStore } from '@marmeon/auth';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('signs the other browser out', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const { session } = cookieNames(app); // `__Host-…` when APP_URL is https
  const signIn = async () => {
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } });
    return app.withCookie(session, login.cookie(session)!);
  };
  const laptop = await signIn();
  const phone = await signIn();
  await laptop.get('/dashboard').assertOk();
  await phone.get('/dashboard').assertOk();

  const window = { idleSeconds: 7200, maxSeconds: 86_400 };
  const rows = await app.make(SignInStore).list(ada.id, window);
  expect(rows).toHaveLength(2);
  await app.make(SignInStore).end(ada.id, rows[0]!.id);

  // The browser whose row is gone is a guest at its next request; the other one is not.
  const signedOut = (await Promise.all([laptop.get('/dashboard'), phone.get('/dashboard')])).filter((response) => response.status === 302);
  expect(signedOut).toHaveLength(1);
});
```

To test the controller itself, confirm the password in the test first (the session needs a recent confirmation, a password or a passkey); `POST /confirm-password`
does that in the starter kit.

## What your app implements

Most apps implement one contract: the `UserProvider`, which the starter kit's `UserRepository` already is. The rest ship with
the package and keep their rows in the database. Each of them is a contract you can bind your own implementation under, for rows in
another place:

| Contract | Kind | Required members | Default | If a member is missing |
| --- | --- | --- | --- | --- |
| `UserProvider` (`@marmeon/auth`) | Interface | `findById`, `findForSignIn`, `updatePasswordHash`, `updateSessionKey`, `updateEverySessionKey` (both finders return `Credentials` with `sessionKey`) | None: the app binds one. The starter kit's `UserRepository` delegates the last three to `credentialWriter()`. | Does not compile. In JavaScript or through a cast, a missing `updateSessionKey` or `updateEverySessionKey` is error A5 when needed; any other member is a plain `TypeError`. |
| `Hasher` (`@marmeon/auth`) | Interface | `make`, `verify`, `needsRehash`, `dummyVerify`, `failureFloorMs` | `PasswordHasher` (Argon2id by default), bound by the package. | Does not compile. In JavaScript, error A6 at the first sign-in without `failureFloorMs`, or when it answers anything but a finite number of milliseconds, 0 or more. |
| `SignInStore` (`@marmeon/auth`) | Abstract class | `create`, `seen`, `list`, `end`, `endAll`, `endEveryone`, `prune`, `issueToken`, `dropToken`, `consume`, `remembered`, `forgetToken`, `rebind` | `DatabaseSignIns` on `sign_ins`, once the app has a `UserProvider`. | Does not compile. In JavaScript, error A6 for `endAll`, `dropToken` or `endEveryone`, before anything is ended. |
| `PasswordResetTokenStore` (`@marmeon/auth`) | Abstract class | `create`, `consume`, `forget`, `prune`, `forgetEveryone` | `DatabasePasswordResetTokens` on `password_reset_tokens`. | Does not compile. In JavaScript, error A6 for `forgetEveryone`. |
| `AccessTokenStore` (`@marmeon/auth`) | Abstract class | `create`, `find`, `touch`, `list`, `revoke`, `revokeAll`, `prune`, `revokeEveryone` | `DatabaseAccessTokens` on `personal_access_tokens`. | Does not compile. In JavaScript, error A6 for `revokeEveryone`. |
| `EmailChangeStore` (`@marmeon/auth`) | Abstract class | `create`, `pending`, `waiting`, `claim`, `forget`, `prune`, `forgetEveryone` | None: the app binds one, `container.singleton(EmailChangeStore, DatabaseEmailChanges)` for the default on `email_changes`. | Does not compile. In JavaScript, error A6 for `forget` and `forgetEveryone`, before anything is written or ended. |
| `TwoFactorState` (`@marmeon/auth`) | Abstract class | `factors`, `enabledSince`, `removeAll` | `NoTwoFactorState`: nobody has a second factor. The starter kit binds `TwoFactorStore` (on `two_factor_authentications` with `two_factor_recovery_codes`) and the passkeys. | Does not compile. In JavaScript, error A6 when `combineFactors()` is called or before a password reset spends its token. |
| `SessionStore` (`@marmeon/session`) | Abstract class | `read`, `write`, `destroy`, `gc` (`destroyUser` is optional) | The store of `SESSION_DRIVER`: `file`, `database`, `redis` or `memory`. | Does not compile. |

The A5 and A6 errors are listed under [error codes](errors.md#server-error-codes). `TwoFactorStore` and `PasskeyStore` are
implementations, not contracts: you bind them, you do not extend them. Their write methods are not API: change a user's factors through `TwoFactor` and `Passkeys`, which check the password, end the other sessions and dispatch the events. The drivers of cache, queue and storage are interfaces of
their own packages.

Whether a member is required or optional follows from one question, [whether it is security-relevant](#security-relevant-members):
a member that is never has a default.

### For your own user provider

A `UserProvider` implements every method of the table. `findById()` and `findForSignIn()` both return the `sessionKey`, and
`updatePasswordHash()` answers with a boolean. A provider that still has the old name `findForLogin()` stops the app at its start with an A5 error that names `findForSignIn()`; the signature is the same. The other three decide whether a session survives, so the package writes them for
you: `credentialWriter(db, { table })` returns them for a table with the columns `id`, `password`, `session_key` and `updated_at`
(`table` defaults to `'users'` and must be a plain lower-case name, or it throws a `TypeError`). Delegate to it, as the starter
kit's `UserRepository` does. The kit keeps the default table; a repository of your own passes its table, which `Repository.table`
gives (it is public):

```ts
import { credentialWriter } from '@marmeon/auth';

updatePasswordHash(id: number, hash: PasswordHash, options?: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null }) {
  return credentialWriter(this.db, { table: this.table }).updatePasswordHash(id, hash, options);
}
updateSessionKey(id: number, key: string, expected: string | null | undefined) {
  return credentialWriter(this.db, { table: this.table }).updateSessionKey(id, key, expected);
}
updateEverySessionKey(key: string) {
  return credentialWriter(this.db, { table: this.table }).updateEverySessionKey(key);
}
```

Pass the repository's own connection (`this.db`): it follows an enclosing transaction, which keeps a new password, its session key and
the revoked tokens in one unit. A fix to the statements reaches you with an update of `@marmeon/auth`; the copy in your repository does
not. Write them yourself only when the columns differ; `updateEverySessionKey()` for comparison:

```ts
async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number | undefined }> {
  const result = await this.db.updateTable('users').set({ session_key: key }).executeTakeFirst(); // one UPDATE, no WHERE
  const accounts = Number(result.numUpdatedRows);
  const sample = accounts > 0 ? await this.db.selectFrom('users').select('id').where(sql<boolean>`session_key = ${key}`).limit(1).executeTakeFirst() : undefined;
  return { accounts, sampleId: sample?.id };
}
```

It is one statement and has no `WHERE`: no tenant or soft-delete scope, since a sample cannot reveal an account the statement
skipped. Return how many rows it wrote (a whole number, 0 or more) and the id of one account it wrote (`sampleId`, which an empty table cannot give). The
framework refuses a count that is not a whole number, but it cannot tell a true `0` from a statement that wrote nothing. Do not
touch `updated_at`: no account changed.

At run time the framework checks only what it can: that `updatePasswordHash()` and `updateSessionKey()` answer with a boolean, that
`findById()` hands a new key back, and that `updateEverySessionKey()` counts and names an account. It cannot tell a provider that
ignores `expected` or `expectedSessionKey` and answers `true` from a correct one. Those compare-and-sets are yours when you write the
statements: test them in your app (a write over a stale `expected` or `expectedSessionKey` must return `false` and leave the row
alone).

### Your own stores

The stores in the table are abstract classes. The class is the contract and the key you bind it under:
`container.singleton(AccessTokenStore, YourTokens)` and a constructor that asks for an `AccessTokenStore` work as with any other key.
Building the abstract class itself, which is what an unbound key amounts to, fails with K1 and the line
`AccessTokenStore is abstract: bind a store with container.singleton(AccessTokenStore, YourStore)`.
A store of your own extends the class, calls `super()` and implements every abstract method:
```ts
import { AccessTokenStore } from '@marmeon/auth';

export class RedisAccessTokens extends AccessTokenStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    super();
    this.#redis = redis;
  }

  async revokeEveryone(): Promise<number> {
    // …
  }

  // create, find, touch, list, revoke, revokeAll and prune as well
}
```

A class that only `implements` the contract, and an object literal, do not compile: the class carries a private mark that only a
subclass has. That is deliberate. A member added after 1.0 comes with a default in the class, so a store that extends it keeps working;
a structural copy would break at the first call of the new member.

Extend the classes of the framework only where they are abstract. The stores it ships (`DatabaseSignIns`, `DatabaseAccessTokens`,
`DatabasePasswordResetTokens`, `DatabaseEmailChanges`, `TwoFactorStore`, `PasskeyStore` and the session stores) are implementations, and an override of one of
their methods can break the guarantee of another: a store of your own extends the base class, never a `Database…` store.

The ids these stores take are `AuthUserId`, the type of `id` in your [`AuthTypes`](#the-user-type-and-where-users-come-from) user: a
number if your users have a number, a string for UUIDs.

The call that [ends every session of every account](#ending-every-session-of-every-account) needs `SignInStore.endEveryone()`,
and `PasswordResetTokenStore.forgetEveryone()` and `AccessTokenStore.revokeEveryone()` unless you pass `--keep-reset-tokens` or
`--keep-api-tokens`. Each deletes every row in one statement and returns how many. The call refuses with error A6 before it changes
anything when a store lacks its method.

`EmailChangeStore` is opt-in: the package binds none, and an app without a change of address needs nothing. Once one is bound, a new
password (a change or a reset), `AccountSessions.end()` and `AccountSessions.endEveryone()` drop the pending changes of the account (of
every account), so that a link a thief asked for does not outlive them; they need `forget()` and `forgetEveryone()` for it and refuse with
error A6 when the store lacks one. `create()` takes the session key the asking session was checked against and stores the change only while that key is still the account's,
in one statement, so a request that runs next to a new password cannot leave a change behind; it answers `undefined` when the key has
changed. The key is kept in the row, and `claim()` uses the change only while the account still holds it, so a link ends when the key is replaced by anything, such as signing out the other devices. `DatabaseEmailChanges` depends on the `id` and `session_key` columns of the `users` table: it reads the key there when it stores a change and again when it uses one up, and a change of an account that is gone cannot be used. For another table pass `{ usersTable }` (a plain lower-case name), which needs a factory binding: `container.singleton(EmailChangeStore, (c) => new DatabaseEmailChanges(c.make(Connections), c.make(Clock), { usersTable: 'accounts' }))`. `claim()` uses a change up in one statement and answers `undefined` for a token that is malformed,
unknown, used, expired or another account's. `marmeon auth:prune-tokens` also deletes the expired changes.

A `SessionStore` follows the same rules; see [a store of your own](session.md#a-store-of-your-own).

### Security-relevant members

Every member that is security-relevant is `abstract` and never gets a default, not after 1.0 either. A member counts as
security-relevant if at least one of these holds:

1. **It ends or checks a proof.** It ends, revokes, deletes or checks a proof (a session, a sign-in, a remember-me, reset or API token, a
   factor, a recovery code, a passkey) or decides whether one is still valid (`consume`, `find`, `factors`, `destroy`).
2. **It handles a secret or a binding.** It writes, reads or compares secret material, or the state a fingerprint or a proof is built
   from (a hash, a validator, a fingerprint, a session key, the count of failed attempts).
3. **A guarantee rests on its atomicity.** A caller bases a security property on its being atomic, a compare-and-set or read-after-write.
4. **A default that does nothing would fail open.** A default that does nothing or answers the empty value (`0`, `[]`, `undefined`,
   `true`, `false`) would make the app accept what it refuses otherwise, keep alive what it ends otherwise, skip a limit or a factor, or
   hide a way in from the account's owner that the owner could otherwise see and end. So `SignInStore.list` is security-relevant: a
   `[]` would hide every browser the owner is signed in on.

When in doubt, a member is security-relevant. What is none of these is display metadata (a device name, "last seen"), statistics,
tidying up rows that are no longer valid and could not become valid again through any setting, and hints for performance.
`SessionStore.destroyUser` is the one optional member today: a session it would leave standing ends at its next request anyway,
because the guard finds no user or a changed fingerprint.

A security-relevant member arrives after 1.0 only as a [security hardening](releases.md#what-is-public-api) (which may break in a
minor version and has its own entry in `UPGRADING.md`) or in a major version. Any other new member arrives as a method with a default.
`UserProvider` and `Hasher` are interfaces; a security-relevant member is added to them the same way, and any other member is
optional, with the behaviour when it is missing documented.

## The tables of the stores

The default stores keep their rows in `sign_ins` (with the remember-me tokens), `password_reset_tokens`, `personal_access_tokens`,
`two_factor_authentications` with `two_factor_recovery_codes` and `passkeys`, and `email_changes` once the app binds the `DatabaseEmailChanges`
(one row per account that asked for a new address and has not confirmed it, the link's token only as a `secret()` SHA-256 hash; `users`
never holds an address its owner has not confirmed, so no other module reads one). `SIGN_INS_TABLE`, `PASSWORD_RESET_TABLE` and `EMAIL_CHANGES_TABLE` of `@marmeon/auth` name three of them, for a query or a test of your own. The starter kit's migrations create them. `users` is your
app's own table. Column marks stay with the tables: the hashes, the validators and the authenticator's secret are `secret()`
columns, so `selectAll()` and relations never return them.

`/up/ready` is red until every table of a store the app uses has the columns the store needs, and says which command to
run. A table counts as used when its store is the database one: the sign-ins, the reset links and
the API tokens once the app has a `UserProvider`, the change-of-address links when the app binds `DatabaseEmailChanges`, the second factor when `TwoFactorState` is
or contains the `TwoFactorStore`, and the passkeys with the `PasskeyServiceProvider`. A store of your own keeps its own table, and
readiness waits for none of ours: an app that wants no reset links or no API tokens binds a store of its own for them
(`container.singleton(AccessTokenStore, MyTokens)`), because with a `UserProvider` the default stores count as used. Readiness is also red
while a column that holds a secret (`token_hash`, `validator_hash`, `secret`, `code_hash`) lacks its `secret()` mark, as in a table made by hand.

From 0.3 there is no automatic way to the tables of the starter kit and to `sign_ins`; see the [upgrade guide](../UPGRADING.md).

## Signed-in pages are never cached

While someone is signed in, every answer of the `web` group goes out with `Cache-Control: no-store, private`: pages, their JSON
for client-side visits, redirects and error pages. Without it, the browser would keep them in its cache, and Back after signing out
would show them again without asking the server. The middleware, `NoStoreWhenSignedIn`, asks the session and never loads the user.
Every app with `@marmeon/auth` has it.

A route that sets its own `Cache-Control` keeps it, but never as `public`: the answer of a session is sent as `private`. An example is a route with `cacheControl('private, max-age=60')`. Then its answer may
stay in the browser after a sign-out: set your own header only on answers that hold nothing of the user. An app that does keep such answers signs out with `history.clear({ siteData: ['cache', 'storage'] })` after `signOut()`, which asks the browser to drop its cache too; the [client features](client-features.md#the-browsers-storage-on-sign-out) page has the cost.

## Events

`@marmeon/auth` dispatches these events through the app's event dispatcher:

| Event | When | Fields |
| --- | --- | --- |
| `SignedIn` | `attempt()` (after the second factor if the account has one), `signIn()`, a sign-in by the remember-me cookie or with a passkey alone | `user`, `remember`, `at`, `via` (`attempt`, `app`, `remember` or `passkey`), `ip`, `userAgent` |
| `SignedOut` | `signOut()` | `user` |
| `SignInFailed` | `attempt()` with an unknown identifier or a wrong password | `identifier`, and `user` when the identifier is known |
| `SignInLockedOut` | `attempt()` turns an attempt away (`scope: 'client'`), or an account takes no more password sign-ins for the day (`scope: 'account'`, once per window) | `identifier`, `ip`, `scope` |
| `Registered` | Your registration, after it created the account | `user` |
| `PasswordChanged` | `updatePassword()` | `user`, `revokedTokens` (the API tokens the new password revoked, `0` unless `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`) |
| `EmailChanged` | `EmailChange.confirm()`, and `EmailChange.request()` without private registration, once the address is written | `userId`, `previousEmail` (`null` if the user had none), `email` |
| `PasswordReset` | A reset with a link from the mail | `user`, `revokedTokens` (as for `PasswordChanged`) |
| `EverySessionEnded` | `AccountSessions.endEveryone()`, `auth:end-all-sessions` | `at`, `accounts`, `resetTokens`, `accessTokens`, `signIns` (the counts), see [ending every session of every account](#ending-every-session-of-every-account) |
| `RememberTokenReused` | A [remember-me cookie](#remember-me) that a rotation had replaced came back, however many rotations ago, or a known cookie came with a validator that was never issued: it was copied | `user`, `at`, `ip`, `userAgent`, `sessionsEnded` |
| `TwoFactorEnabled`, `TwoFactorDisabled`, `RecoveryCodesGenerated`, `RecoveryCodeUsed`, `TwoFactorChallengeFailed` | The second factor of an account changes or is used | See [two-factor authentication](two-factor-authentication.md#events) |
| `PasskeyRegistered`, `PasskeyRemoved`, `PasskeyCloneSuspected`, `PasskeySignInFailed` | A passkey is added or removed, is suspected of being copied, or fails a passwordless sign-in | See [passkeys](passkeys.md#events) |

`SignInFailed` carries what was typed as the identifier, never the password. Use it for an audit log, and never show it to the client:
it tells whether the address has an account. The `ip` and `userAgent` of `SignedIn` are the request's, the address resolved through
`SERVER_TRUSTED_PROXIES` like `ctx.ip`, unless the call to `attempt()` or `signIn()` passed others. Outside a request they are `null`.
`RememberTokenReused` is dispatched once for each copied cookie, after the user's sign-ins were deleted and their sessions ended (or could not be, see `sessionsEnded`), and only for an account that still exists. Its `ip` and `userAgent` belong to the request that presented the old or never-issued value: whoever holds the copy, possibly the thief, or, more rarely, the owner's browser that missed the response carrying a renewal (a cancelled load, a dropped connection), so a mail should say so. A cookie that is no longer the current or just-replaced one cannot come from a browser that kept up with the rotations, so the owner is told for every old copy. `ip` is `null` when it is not an address, `userAgent` has its control characters removed and is cut to 512 characters, and `sessionsEnded` is `false` when the `UserProvider` could not end the sessions (the tokens are gone either way). The event never carries the cookie or a token. The `userAgent` is text the client chose: show a parsed browser and system (`describeDevice()`) in a mail, not the raw header. A queued listener gets `{ userId, at, ip, userAgent, sessionsEnded }`, with `at` as an ISO 8601 string. The starter kit mails the owner.
`SignedIn` and `TwoFactorChallengeFailed` take the user, an object of the details, and the time last (`new SignedIn(user, { remember: true, via: 'attempt' }, at)`, `new TwoFactorChallengeFailed(user, { during: 'step-up' }, at)`); the time may be left out, and so may every detail.
A queueable event's payload has a name — `RememberTokenReusedPayload`, `SignedInPayload` and so on, each the same as `EventPayload<typeof …>` of its class.

`Registered` is dispatched by your app's code, the starter kit's controllers, not by the package; `SignInLockedOut` comes from `attempt()`.

The route `auth.login`, the URL `/login`, the limiters named `auth.login` and the `auth.login.*` translation keys keep their names: they name the page, not the event. A queued listener of `SignedIn` is stored under the event name `auth.signed-in`; a job that an earlier release queued under `auth.login` is held and, after six hours, fails with that name in its message (see `marmeon queue:failed`), so empty the queue with `marmeon queue:work --stop-when-empty` on the old release before deploying.

A listener reacts to a sign-in without the auth module knowing about it:

```ts title="modules/user-profile/listeners/RecordLastLogin.ts"
import type { SignedIn } from '@marmeon/auth';
import { LoginActivityRepository } from '../LoginActivityRepository.ts';

export class RecordLastLogin {
  readonly #activity: LoginActivityRepository;

  constructor(activity: LoginActivityRepository) {
    this.#activity = activity;
  }

  async handle(event: SignedIn): Promise<void> {
    await this.#activity.record(event.user.id, event.at);
  }
}
```

The module registers it with `listeners: [listen(SignedIn, RecordLastLogin)]`. `SignedIn` can also be queued, like 12 more of the events above (the [events](events.md#the-frameworks-events) page marks them). A queued
listener of `SignedIn` gets `{ userId, remember, via, at, ip, userAgent }`, with `at` as an ISO 8601 string, and one of `Registered`
gets `{ userId }`. It reads the account as it is when it runs. The [events](events.md#queued-listeners) page explains queued
listeners.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_SESSION_MAX_HOURS` | `24` | The longest a sign-in lasts in hours, however active: 1 to 720. A valid remember-me cookie signs in again. See [how long a sign-in lasts](#how-long-a-sign-in-lasts). |
| `AUTH_REMEMBER_DAYS` | `30` | Days the remember-me cookie keeps a user signed in, from the sign-in: 0 to 30. `0` turns remember me off: no cookie signs in. |
| `AUTH_REMEMBER_COOKIE` | `marmeon_remember` | The name of the remember-me cookie: letters, digits, `_` and `-`. Over HTTPS it gets the `__Host-` prefix. |
| `AUTH_LOGIN_ATTEMPTS_PER_MINUTE` | `5` | Password sign-ins a minute for one identifier from one client: 1 to 60. See [limits](#limits-on-password-sign-ins). |
| `AUTH_ACCOUNT_SIGN_INS_PER_DAY` | `100` | Password sign-ins a day for one account, from all clients: 10 to 100000. |
| `AUTH_DEVICE_COOKIE_DAYS` | `90` | Days the device cookie lasts that a password sign-in or a completed reset hands the browser: 0 to 365, `0` turns it off. |
| `AUTH_PASSWORD_TIMEOUT_SECONDS` | `900` | Seconds a typed password or a proven passkey counts for `confirmedPassword()`: 1 or more. |
| `AUTH_RESET_MINUTES` | `60` | Minutes a password reset link works: 1 to 1440. See [password reset](passwords.md#configuration). |
| `AUTH_RESET_THROTTLE_SECONDS` | `60` | Seconds before another reset link goes to the same address: 0 or more, `0` turns the pause off. |
| `AUTH_EMAIL_CHANGE_MINUTES` | `60` | Minutes the link of a change of address works: 5 to 1440. See [changing the address](#changing-the-address). |
| `AUTH_EMAIL_CHANGE_THROTTLE_SECONDS` | `60` | Seconds an account waits after a request for a new address that sent a link: 0 or more, `0` turns the pause off. See [changing the address](#changing-the-address). |
| `AUTH_TOKEN_PREFIX` | `marmeon_` | The prefix of API tokens. See [API tokens](api-tokens.md#the-token-format). |
| `AUTH_PRIVATE_REGISTRATION` | `true` | The private registration of the starter kit. See [starter kit](starter-kit.md#private-registration). |
| `AUTH_UNVERIFIED_DAYS` | `7` | Days before `auth:prune-unverified` deletes an account without a confirmed address: 0 to 99999, `0` keeps them. See [email verification](verification.md#unconfirmed-accounts). |
| `APP_NAME` | none | The app's name shown by authenticator apps next to the code. Two-factor setup needs it. See [two-factor authentication](two-factor-authentication.md#setting-up). |
| `AUTH_PASSKEY_RP_ID` | host of `APP_URL` | The RP ID of [passkeys](passkeys.md#requirements): a parent domain of every allowed origin. Checked when passkeys are first used. |
| `AUTH_PASSKEY_ORIGINS` | origin of `APP_URL` | The origins [passkeys](passkeys.md#requirements) are accepted from, comma-separated and exact: `https:`, or `http://localhost`. |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | `false` | `true`: a new password, set by the user or by a reset, revokes every API token of the user. A boolean (`true`, `false`, `1`, `0`); anything else stops the start. See [API tokens](api-tokens.md#revoking-every-token-with-a-new-password). |

Each number names its range. A value outside it stops the start. The `HASH_*` variables are on the [hashing](hashing.md#configuration) page.

## Testing

A test acts as a signed-in user with `actingAs()`, which leaves a session as a real sign-in does:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('shows the notes to signed-in users only', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).get('/notes').assertOk();
  await app.get('/notes').assertRedirect('/login');
});
```

`UserFactory` makes users with a confirmed address. A new app's `.env.test` sets `SESSION_DRIVER=memory`, so the sessions of `actingAs()` live in the test process. The [HTTP tests](http-tests.md#sessions-and-signing-in) page shows the assertions for sessions,
sign-in and sign-out.
