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
import type { Credentials, PasswordHash, UserProvider } from '@marmeon/auth';
import { Repository, secret, sql } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  findForLogin(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  /**
   * Writes `hash` and answers whether it wrote. With `expected`, only where the stored hash still equals it, in one statement: a
   * rehash or "sign out other devices" never puts an old password back over a reset that landed meanwhile. Without it, writes
   * regardless. With `sessionKey`, the same statement stores that session key too, and with `expectedSessionKey` as well (`null`:
   * none) only where the stored key still is that one.
   */
  async updatePasswordHash(id: number, hash: PasswordHash, options: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null } = {}): Promise<boolean> {
    const { expected, sessionKey, expectedSessionKey } = options;
    // An empty key would give the fingerprint of an account without one (NULL).
    if (sessionKey !== undefined && sessionKey.length < 32) throw new Error('A session key is at least 32 characters: use a random value.');
    // The column is a secret: it cannot be compared in a typed `where`, and the comparison must stay in this one statement.
    const result = await this.db
      .updateTable('users')
      .set({ password: hash, ...(sessionKey === undefined ? {} : { session_key: sessionKey }), updated_at: new Date() })
      .where('id', '=', id)
      .$if(expected !== undefined, (query) => query.where(sql<boolean>`password = ${expected}`))
      .$if(sessionKey !== undefined && expectedSessionKey !== undefined, (query) =>
        query.where(expectedSessionKey === null ? sql<boolean>`session_key is null` : sql<boolean>`session_key = ${expectedSessionKey}`),
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  // updateSessionKey() and updateEverySessionKey() complete the provider, see below.

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query.selectAll().select((eb) => [secret(eb, 'password'), secret(eb, 'session_key')]).executeTakeFirst();
    if (!row) return undefined;
    const { password, session_key, ...user } = row;
    return { user, passwordHash: password as PasswordHash, sessionKey: session_key };
  }
}
```

The example leaves out `updateSessionKey()` and `updateEverySessionKey()`, which a provider needs as well: see
[signing out other devices without a password](#signing-out-other-devices-without-a-password) and
[for your own user provider](#for-your-own-user-provider). The starter kit's `UserRepository` has all of them.

`Credentials` is `{ user, passwordHash, sessionKey }`: the hash travels next to the user, never inside it, so it cannot reach a page by
accident. A user who cannot sign in with a password has `passwordHash: null`. The `sessionKey` is a value of
the account that ends its other sessions when it changes, as [signing out without a password](#signing-out-other-devices-without-a-password)
explains; it is `null` for an account that has none yet. Both `findById()` and `findForLogin()` must return it: a `findForLogin()` that
leaves out a key `findById()` returns makes `attempt()` throw, and a bad sign-in is not what it reports. `findForLogin()` gets what the person typed after
the request's schema normalized it; the starter kit's schema trims the address and makes it lower case. Until a provider is
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

`updateSessionKey()` and `updateEverySessionKey()` are required as well, see [signing out other devices without a password](#signing-out-other-devices-without-a-password)
and [ending every session of every account](#ending-every-session-of-every-account). A provider of your own that leaves one out does
not compile, and one without them at run time (JavaScript, a cast) throws error A5 when the method is needed.

At run time the framework checks only what it can: that `updatePasswordHash()` and `updateSessionKey()` answer with a boolean, that
`findById()` hands a new key back, and that `updateEverySessionKey()` counts and names an account. It cannot tell a provider that
ignores `expected` and answers `true` from a correct one. The compare-and-set is yours: test it in your app (a write over a stale
`expected` must return `false` and leave the row alone). A JavaScript provider written against the old positional parameter
(`updatePasswordHash(id, hash, expected)`) receives an object there now: its compare never matches, and a sign-in that needs a rehash is
refused as a wrong password until it takes `{ expected }`.

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

`attempt()` checks a password and signs the user in. The starter kit's `LoginController` counts the attempt first and checks
afterwards:

```ts title="modules/auth/controllers/LoginController.ts"
import { Auth, Lockout } from '@marmeon/auth';
import { clientKey, RateLimiter } from '@marmeon/cache';
import { EventDispatcher } from '@marmeon/core';
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
  readonly #limiter: RateLimiter;
  readonly #events: EventDispatcher;
  readonly #translator: Translator;

  constructor(auth: Auth, limiter: RateLimiter, events: EventDispatcher, translator: Translator) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#events = events;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password, remember } = ctx.body;
    const key = `login:${email}|${clientKey(ctx.ip)}`;
    if (!(await this.#limiter.attempt(key, 5, 60))) {
      await this.#events.dispatch(new Lockout(email, ctx.ip));
      throw new ValidationError({ email: [this.#translator.get('auth.login.throttled', { seconds: await this.#limiter.availableIn(key) })] }, { email });
    }
    const signedIn = await this.#auth.attempt(email, password, { remember });
    if (!signedIn.ok) {
      // The password was right, but the account has a second factor: nobody is signed in yet, the code comes next.
      if (signedIn.error.kind === 'two-factor-required') {
        await this.#limiter.clear(key);
        return this.redirect().route('auth.two-factor.challenge');
      }
      throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
    }
    await this.#limiter.clear(key);
    return this.redirect().intended().route('dashboard');
  }
}
```

`attempt(identifier, password, { remember })` returns a [`Result`](errors.md#results): `ok` with the user, or an `err` of kind
`invalid-credentials` or `two-factor-required`. An unknown address, a wrong password and an account without a password all give
`invalid-credentials`, the same answer in the same time: for an unknown address, the hasher spends as long on a check that always
fails. A failed attempt also waits until it has taken as long as a check over the slowest hash parameters this process has
verified, so accounts with an older hash (after a change of driver or costs) are not told apart either, see
[hashing](hashing.md#making-and-checking-hashes). Neither the answer nor its duration tells a stranger which addresses have an
account.

`two-factor-required` comes only after a correct password, for an account that set up a [second
factor](two-factor-authentication.md). Nobody is signed in then: no `Login` event, no remember-me cookie, `auth.user()` is
`undefined`. The session keeps the right password for five minutes, `auth.pendingSecondFactor()` names the factors it waits for,
and the error carries them as `factors`. Redirect to the page that asks for the code. An app that ignores the case still signs
nobody in. Without a source of factors bound (see [Setting up](two-factor-authentication.md#setting-up)) the case never happens. When the stored hash was made with other costs than the
configured ones, `attempt()` hashes the password again and stores the new hash; no session of the account ends by it (see [changing the
password](#changing-the-password)). It also notes the time, so the password counts as
just confirmed for [sudo mode](#sudo-mode).

A password reset, a new password or [an ending of every session](#ending-every-session-of-a-user) that lands while the password is
still being checked ends that sign-in too: `attempt()` answers `invalid-credentials`, like for a wrong password, and a new attempt
checks the new state.

The limit is counted before the password is checked, in one atomic step: guesses sent at the same moment cannot all slip under
it. Five failed attempts a minute for one address from one client lock it for the rest of the minute; a client is its IPv4
address or its IPv6 /64 ([`clientKey()`](rate-limiting.md#keys-and-the-clients-address)). The starter kit also puts a `login-client`
limit on `POST /login`: 30 requests a minute from one client, whichever addresses they name. It counts every request, successful
sign-ins and validation failures included, so a CGNAT, a school or an office behind one address shares the 30 a minute. The number is
in `modules/auth/AuthServiceProvider.ts`. The
[rate limiting](rate-limiting.md#defining-limiters) page covers limiters.

The starter kit counts one more thing: the password sign-ins to one account from every client together, 100 a day. The 101st gets
"Too many failed sign-ins for this account. Reset your password or sign in with a passkey." even with the right password, for an address
without an account as for one with. A sign-in that succeeds and a completed password reset start the count over; a passkey sign-in is not
affected. The owner gets a mail once. See [the starter kit](starter-kit.md#guesses-against-one-account).

`login(user)` signs a user in without a password, for example right after a registration. It returns `'signed-in'`, or
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

## Signing out

`logout()` signs the user out on this device. The session's data, its id and its CSRF token are all replaced, and the remember-me
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
    await this.#auth.logout();
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
| `SESSION_LIFETIME` | 120 minutes | A session that makes no request: the time since the last one. | `SESSION_LIFETIME=60` (at most an hour idle) is recommended for an app that needs AAL2 (ASVS 7.3.1). |
| `AUTH_SESSION_MAX_HOURS` | 24 hours | A sign-in, however active the user is. A valid remember-me cookie signs in again. | 24 hours is the limit NIST SP 800-63B-4 sets at AAL2. |
| `AUTH_REMEMBER_DAYS` | 30 days (0 to 30) | The [remember-me](#remember-me) cookie, counted from the sign-in that made it. | AAL1: a convenience, not a proof. |
| `twoFactor()` `maxAge` | 24 hours | The proof of a [second factor](two-factor-authentication.md#requiring-it); then the user is asked for it again. | AAL2 holds only on routes behind `twoFactor()`. |
| `FACTOR_CHANGE_MAX_AGE` | 15 minutes, no setting | The proof that [changing the factors](two-factor-authentication.md#changing-the-factors), the e-mail address or an API token asks for. | A factor proven within this time. |
| `AUTH_PASSWORD_TIMEOUT` | 15 minutes | The password or passkey confirmation of [sudo mode](#sudo-mode). | The password or a passkey; only a passkey also counts as a second factor. |

`SESSION_LIFETIME` is renewed by every request, so on its own an active session would never end. `AUTH_SESSION_MAX_HOURS` (1 to 720)
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
lasts longer. `marmeon auth:prune-tokens` (the starter kit schedules it daily) deletes every token that expired or is older than
`AUTH_REMEMBER_DAYS` days, all of them with `0`, so raising the value again does not bring old tokens back. A value above 30 stops
the boot.

The cookie is consulted when the session has no user, and when the session's [sign-in has reached its limit](#how-long-a-sign-in-lasts). It holds a selector and a secret validator. The `remember_tokens`
table keeps one row per device, with the validator only as its SHA-256 hash, so a leaked table signs nobody in. A table of your
own needs what the starter kit's migration gives it: a unique `selector` of up to 32 characters, the validator hashes as
64-character `secret()` columns, a nullable `account_fingerprint` of up to 64 characters, and `user_id` with `cascadeOnDelete()`, so a
deleted user's tokens go with the account.

An app made before the column existed adds it with a migration named with the current timestamp, so that it sorts after the rename's, before the new code serves requests: until the column
is there, a request with a remember-me cookie and no session fails with a database error.

```ts title="modules/auth/migrations/<timestamp>_add_account_fingerprint_to_remember_tokens_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('remember_tokens', (table) => table.string('account_fingerprint', 64).nullable()),
  down: (schema) => schema.alter('remember_tokens', (table) => table.dropColumn('account_fingerprint')),
});
```

A token is bound to the account state the sign-in verified: it stores the same fingerprint a session keeps (an HMAC of the
account's id and session key under a key derived from `APP_KEY`, never the key itself), and a cookie signs in only while the account still has that
fingerprint. A reset, a new password, a new session key or an ending of the account's sessions therefore refuses every token made
before it, even one a sign-in wrote a moment after the account changed. A refused token is deleted and the request is a guest, like
an invalid one. A token without a fingerprint, such as a row from before the column existed, is refused: when you add the column,
the cookies of existing devices stop working once and the users sign in again. The device that stays signed in when
`updateSessionKey()` or `logoutOtherDevices()` changes the account keeps its token. A rehash during `attempt()` (new `HASH_*` costs,
say) changes the password hash and nothing the fingerprint is made of: no session and no remember-me cookie of the user's other
devices ends by it. A token made before the fingerprint left out the hash is refused once, like a token without a fingerprint.

- **Every use rotates the validator.** The cookie gets a new value, and the old one stops working. A second tab that sends the old
  value within 10 seconds of the rotation still passes.
- **A copied cookie ends every remember-me token and every session of the user.** An old validator that comes back later, even after
  the owner's browser has rotated several times since, means two browsers hold the same cookie, and the one that used it first already has a session. All of the user's remember-me tokens are
  deleted, every session ends at its next request (see [ending every session of a user](#ending-every-session-of-a-user)), and
  the app logs a warning with the address and the browser of the request that presented the old cookie, and dispatches
  [`RememberTokenReused`](#events) so the app can tell the owner. The request that presented the old cookie is a guest. If the `UserProvider` cannot store a session
  key, ending the sessions fails: that is logged as an error, the event says `sessionsEnded: false`, and only the tokens are gone.
  A false alarm, such as a lost response after a rotation or a browser that restores an old cookie, signs the user out on every
  device.
- **A sign-in without "remember me" drops the cookie the browser already carried.** One token per device: the sign-in deletes the token
  of the cookie it finds and the cookie with it, whether or not [sign-in tracking](#sign-ins) is on. With tracking, the row of that token
  is deleted too, so the list does not show a browser as kept signed in by a cookie that no longer works. Only the row of the user who
  signs in is deleted: on a shared browser the cookie of another user loses its token, and its row stays listed until its remember time
  ends or its owner ends it.
- **Requests that only read never use it.** An island cannot sign in: rotating the token there would hand the new value to no
  one. The next page request signs in.

To keep the tokens somewhere else than the table, bind your own `RememberTokenStore`. Its `create()` receives the fingerprint, and
`consume()` must return it as `fingerprint` (kept over every rotation); a store that drops it makes every cookie useless. The optional
`rebind(userId, cookie, fingerprint)` replaces it for the device that stays signed in; it checks the validator of the cookie like `consume()` does (the current one, or the previous one inside the grace window) and answers a `Result`: `err({ kind: 'stolen', userId, reused })` for a stale validator, after deleting the user's tokens, and `invalid` for an unknown row. `logoutOtherDevices()` and `updateSessionKey()` then end every session of the account, as at a copied cookie, and keep no token. Its `consume()` returns `createdAt` with the device: when the token was made, kept over every rotation. A token made before the account's [second factor](two-factor-authentication.md#setting-up) was confirmed is refused by it. `createdAt` also sets the `AUTH_REMEMBER_DAYS` bound, and a missing or invalid one refuses every remember-me sign-in. `prune(maxAgeDays)` must delete the tokens that expired and those made `maxAgeDays` days ago or earlier (every token with `0`). When an old validator comes back, `consume()` returns `err({ kind: 'stolen', userId, reused })` and must have deleted the user's tokens; deleting them and deciding which request reports are one atomic step (one `DELETE … RETURNING`, say), so that a failed statement deletes nothing and the next replay reports the theft again. The window that remains is a process that dies, or an `AccountSessions.end()` that fails (it is logged), between the deletion and ending the sessions: the tokens are gone, the sessions of the thief are not, until they expire. `reused: true` means the presented validator was the one just replaced by a rotation; it is information only. An older validator, or one that was never issued, presented with a known selector is a copy as well (the selector is random), and every `stolen` dispatches `RememberTokenReused`. Of parallel requests that present the old validator, only the one that removed the token reports `stolen`; the others get `invalid`.

## Sudo mode

Some pages ask for a confirmation again even though the user is signed in, such as the page with the API tokens.
`confirmedPassword()` lets a user through who typed the password, or proved a [passkey](passkeys.md#confirming-sudo-mode) with user
verification, within the last `AUTH_PASSWORD_TIMEOUT` seconds, 15 minutes by default:

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
`423 {"message":"Password confirmation required."}`. `confirmedPassword({ confirmRoute, seconds })` names another page or another
time.

The confirmation page posts the password to `auth.confirmPassword(password)`, which checks it and notes the time. For a user
without a password it takes as long and returns `false`. A user with a passkey can confirm with it instead:
[`passkeys.confirm()`](passkeys.md#confirming-sudo-mode) notes the time the same way, and a [passwordless sign-in](passkeys.md#passwordless-sign-in)
counts as a fresh confirmation, since the passkey was proven just now. `attempt()` notes the time as well (for an account with a
second factor, dated when the password was typed, not when the factor was proven); `login()` does not, since nobody proved anything, and it forgets a
confirmation noted before: the new sign-in starts outside sudo mode, even over the session of the same account, and proving a
second factor afterwards does not change that. A confirmation counts only inside the sign-in it was given for.

A confirmation is enough to reach a page, but not for every action. What lets whoever holds the session stay in the account after the
owner has recovered it asks for the **current password in the same form**, whatever confirmed sudo mode, such as: changing the e-mail
address, creating an API token, registering, releasing or removing a passkey, turning two-factor authentication on or off
(`TwoFactor.confirm(code, password)`, `disable(password)`; `confirm()` checks the password before the code, so only whoever knows it spends the code budget), making new recovery codes (`regenerateRecoveryCodes(password)`) and changing the password. A passkey alone can confirm sudo mode, so without that second question a hijacked session could add a way in that
survives the owner's recovery.

Every `confirmedPassword()` route is reachable with a passkey alone, the reading ones too (a data export) and those that end or rename something else (ending another sign-in, renaming a passkey). Whatever creates a way into the account asks for the password in its form, as above; add that question to your own routes of the same kind.

A confirmation or a proven second factor dated up to a minute ahead of this server's clock still counts, so that a cluster whose clocks differ by a little does not send a user back to the confirmation page. Anything further ahead does not count, and the window is counted from the time the confirmation carries, so one dated ahead lasts at most a minute longer than the window above; a confirmation dated in the past is never valid for longer.

An account with neither a password nor a passkey, such as one created by a sign-in link or by an OAuth provider your app wrote, has
no way to confirm sudo mode yet: `confirmedPassword()` never lets it through.

The password checks are counted for each sign-in (five a minute and twenty an hour, a right password clears the minute) and, for a sign-in that did not begin
with a typed password, also for the account (twenty an hour across all such sign-ins). The starter kit does so for the confirmation, the password change, "sign out other
devices", turning two-factor authentication off, the e-mail change and a new API token; `Passkeys` and `regenerateRecoveryCodes()` do it themselves. A stolen session must not become a way to guess the password, and a passkey-only session
that uses up the account's count must not lock out the owner, who typed the password to sign in: the account's count never applies to a sign-in made by `attempt()`.
When the account's count is what holds a check up, `takePasswordCheck()` answers `throttled` with `account: true`, and the starter kit then says "Sign in again with your password to continue" instead of a wait. `auth.passwordCheckScope()` says whose checks these are (the sign-in's own random key, which a new session id within the sign-in keeps, and whether it began with a typed
password); `takePasswordCheck(limiter, scope, userId)` counts one and returns the seconds to wait, and `clearPasswordCheck()` clears the minute after a right password.

## Changing the password

`updatePassword(password)` stores a new hash for the signed-in user, together with a new session key. The key is what ends sessions:
the hash is not part of the fingerprint a session keeps, so this session is bound to the new key and stays signed in. Every other session ends at its
next request, every remember-me token of the user is deleted, this device's included, and `PasswordChanged` is dispatched. With
`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, every API token of the user is revoked as well, in the same transaction as the new
hash, and the log says how many.

`updatePassword()` does not check the current password. The controller does that first, as the starter kit's does, through the
throttle of its password checks:

```ts title="modules/auth/controllers/UpdatePasswordController.ts"
import { Auth, password, type Authenticated } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { throttlePasswordChecks } from '../throttle.ts';

export const UpdatePasswordRequest = defineRequest({
  schema: r.object({ current_password: r.string().required().max(4096), password: password(), password_confirmation: r.string() }).confirmed('password'),
});

export class UpdatePasswordController extends Controller {
  static request = UpdatePasswordRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;
  readonly #translator: Translator;

  constructor(auth: Auth, limiter: RateLimiter, translator: Translator) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdatePasswordRequest> & Authenticated) {
    await throttlePasswordChecks(this.#limiter, this.#translator, this.#auth, ctx.user.id, 'current_password', () => this.#auth.confirmPassword(ctx.body.current_password));
    await this.#auth.updatePassword(ctx.body.password);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.password_changed') });
  }
}
```

`throttlePasswordChecks()` in `modules/auth/throttle.ts` counts the try before the check, per sign-in and per account as above, and
throws a field error for a wrong password. Never check a signed-in user's password without such a limit. The handler's
`& Authenticated` types the context: `ctx.user` is there because the route sits behind `authenticate()`. The
[hashing](hashing.md#the-password-rule) page explains the `password()` rule.

`logoutOtherDevices(password)` signs out every other device without changing the password, or its hash. It checks the password,
returns `false` when it is wrong or when the account's sessions ended meanwhile (a reset landed during the request: nothing is
written), and otherwise stores a new session key, like [`updateSessionKey()`](#signing-out-other-devices-without-a-password). The other
sessions end at their next request, and the remember-me tokens of the other devices are deleted.

The starter kit runs both routes with `.block()`: one such request per session at a time. Two at once could leave the session
with the fingerprint of the other request's key, and sign it out. The [session](session.md#requests-that-must-not-overlap) page
explains `block()`.

### Signing out other devices without a password

An account that signs in by a link or through another provider has no password to check. `updateSessionKey()` signs out its other
devices all the same: it draws a new random session key, stores it with `updateSessionKey(id, key, expected)` of your `UserProvider`, and
gives this session the new fingerprint. The other sessions end at their next request with every session driver, and the
remember-me tokens of the other devices are deleted. It works for accounts with a password too.

The key is a column of the account. Mark it secret, so that `Row<'users'>` and every query that selects all columns leave it out:

```ts title="modules/auth/migrations/2026_10_10_120000_add_session_key_to_users_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('users', (table) => table.string('session_key', 64).nullable().secret()),
  down: (schema) => schema.alter('users', (table) => table.dropColumn('session_key')),
});
```

Your provider stores the key and hands it back as `sessionKey` from `findById()` and `findForLogin()`. A secret column is read
only with `secret()`, as the starter kit's `UserRepository` reads the password hash. Its parts that signing in needs, with the
session key added:

```ts title="modules/auth/UserRepository.ts"
import type { Credentials, PasswordHash, UserProvider } from '@marmeon/auth';
import { Repository, secret, sql } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  findForLogin(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  /**
   * Writes `hash` and answers whether it wrote. With `expected`, only where the stored hash still equals it, in one statement: a
   * rehash or "sign out other devices" never puts an old password back over a reset that landed meanwhile. Without it, writes
   * regardless. With `sessionKey`, the same statement stores that session key too, and with `expectedSessionKey` as well (`null`:
   * none) only where the stored key still is that one.
   */
  async updatePasswordHash(id: number, hash: PasswordHash, options: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null } = {}): Promise<boolean> {
    const { expected, sessionKey, expectedSessionKey } = options;
    // An empty key would give the fingerprint of an account without one (NULL).
    if (sessionKey !== undefined && sessionKey.length < 32) throw new Error('A session key is at least 32 characters: use a random value.');
    // The column is a secret: it cannot be compared in a typed `where`, and the comparison must stay in this one statement.
    const result = await this.db
      .updateTable('users')
      .set({ password: hash, ...(sessionKey === undefined ? {} : { session_key: sessionKey }), updated_at: new Date() })
      .where('id', '=', id)
      .$if(expected !== undefined, (query) => query.where(sql<boolean>`password = ${expected}`))
      .$if(sessionKey !== undefined && expectedSessionKey !== undefined, (query) =>
        query.where(expectedSessionKey === null ? sql<boolean>`session_key is null` : sql<boolean>`session_key = ${expectedSessionKey}`),
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  // Compare-and-set, in one statement: writes only while the stored key is still `expected` (null: none) and says whether it did.
  // `undefined` writes regardless: only `AccountSessions.end()` passes it, to end every session of the account.
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    const result = await this.db
      .updateTable('users')
      .set({ session_key: key, updated_at: new Date() })
      .where('id', '=', id)
      .$if(expected !== undefined, (query) => query.where(expected === null ? sql<boolean>`session_key is null` : sql<boolean>`session_key = ${expected}`))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
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
no request can keep it from ending the sessions. Use `undefined` for nothing else. The same holds for `updatePassword()` and `logoutOtherDevices()`: they anchor the
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

Run such a route with `.block()` as well. `logoutOtherDevices(password)` stays the way for an account with a password: it checks
the password first. An account whose key is still `null` has the id alone in its fingerprint until a new password or a sign-out of the other
devices writes a key.

### API tokens

A new password revokes the user's API tokens only with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, and "sign out other devices"
never does. Otherwise a token stays valid until it expires or is revoked on the tokens page. The
[API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains when to turn it on.

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

`AccountSessions` of `@marmeon/auth` ends every session of an account, and every remember-me cookie with them. Use it after an
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
string), and writes nothing then. Otherwise it goes in three steps, in this order:

1. It deletes every remember-me token of the account, so no cookie signs in again, and a remember-me sign-in that is running
   finds its token gone.
2. It stores a new session key with `updateSessionKey()` of your `UserProvider`. The fingerprint of every session changes, so each
   one ends at its next request, with every driver.
3. It deletes the sessions a store can find at once (only `database`, by its `user_id` column) and returns how many: `removed`.

The session key is what ends the sessions, so your `UserProvider` must store one: a provider without `updateSessionKey()` does not
compile, and at run time `end()` throws error A5 before it changes anything, and names what to add. It also throws when `findById()` does not hand the new key back; the
remember-me tokens are gone by then. The starter kit's accounts have a `session_key` column. A request that is running while `end()` replaces the key cannot bind its session to the new state, so it is signed out as well; Inside a database transaction `end()` throws: each step commits on its own, and a rollback would bring the deleted tokens back.

A custom `RememberTokenStore` needs `exists(cookie)`, which says whether the token of a cookie is still stored and must see a `forgetUser()` at once (no cache, no lagging replica), or a session survives `end()`; a sign-in by a
remember-me cookie asks it right before it starts.

The starter kit brings this as a command, `marmeon auth:end-sessions <email> --force`, for an operator who has no admin page
([Starter kit](starter-kit.md#signing-an-account-out-everywhere)).

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
sessions with every driver: a new password, `logoutOtherDevices(password)` or `updateSessionKey()`. `UserSessions.end(id)` ends every session of a user at once, the current one included, and only with the `database` driver.

## Ending every session of every account

After a leak, such as a copy of the database, a leaked `APP_KEY`, a compromised admin account or cookies stolen in bulk, every
sign-in that exists must end at once. An operator runs one command, and every app has it:

```sh
marmeon auth:end-all-sessions --force
```

From code, such as a job or an admin controller, `AccountSessions.endEveryone()` does the same. Guard the route as you would
[`end()`](#ending-every-session-of-a-user):

```ts
const ended = await this.#accounts.endEveryone(); // { accounts, rememberTokens, resetTokens, accessTokens, signIns }
```

It also revokes every API token and deletes every password-reset token, since a thief who held a session may have created either.
`--keep-api-tokens` and `--keep-reset-tokens` (`accessTokens: false`, `resetTokens: false`) leave them, and the output names what was
kept. The old `--api-tokens` and `--reset-tokens` are refused with a hint, and nothing is ended.

The command takes no arguments (a mistyped `auth:end-sessions <email>` is refused, not widened), prints the environment it runs
in, and logs the operator and the host. `--force` is required in every environment, since it cannot be undone.

| | Ended |
| --- | --- |
| Sessions of every driver, on every instance | At their next request. No restart or deploy is needed. |
| Pending second-factor steps, password and second-factor confirmations | With the session they live in. |
| Remember-me tokens | All deleted. |
| Sign-in rows | All deleted, with [sign-ins](#sign-ins) switched on. |
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

The order is fixed: the remember-me tokens first, so that no cookie signs in again once a later step fails; then the keys; then
the reset tokens and the API tokens, unless kept, then the sign-in rows. The key is written to every row, so a second factor
that is being stored at that moment is refused. The call throws, naming the remedy and before anything is deleted, when the
`UserProvider` or a store it will use lacks its method, and inside a database transaction.

A step that fails stops the call. The message, printed by the command with exit code 1 and logged, names the step, what was
already done, and whether the keys are rotated: if they are, every session is ended and only the clean-up remains. Run it
again: each step deletes or overwrites everything, so a second run is safe and finishes the rest. If the keys were written but the read-back
could not confirm them, the message says "fix the UserProvider, then run it again": a plain rerun fails the same way, so fix `findById()` first.

After the write, `AccountSessions` reads one account back with `findById()` and throws unless its `sessionKey` is the new key.
`findById()` must therefore return the `session_key` column as `sessionKey` straight from the database, with no cache and no lagging
replica. A cache would fail the read-back; a cache or replica that only some lookups hit slips past it and leaves those sessions live.

### For your own user provider

A `UserProvider` of your own implements every method: `findById()` and `findForLogin()` (both with `sessionKey`),
`updatePasswordHash()` (answering with a boolean), `updateSessionKey()` and `updateEverySessionKey()`. The starter kit's
`UserRepository` implements `updateEverySessionKey()` like this, and so does a provider of your own:

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

A custom `RememberTokenStore` needs `forgetEveryone()`, since the call always deletes the remember-me tokens. A custom
`PasswordResetTokenStore` needs `forgetEveryone()` and a custom `AccessTokenStore` needs `revokeEveryone()`, unless you pass
`--keep-reset-tokens` or `--keep-api-tokens`. [Your own stores](#your-own-stores) extend an abstract class that requires both, so a
store without them does not compile; in JavaScript, or through a cast, the call refuses with error A6 before it changes anything. Each
deletes every row in one statement and returns how many.

`AccountSessions` covers the accounts of the bound `UserProvider`; accounts in another table with their own provider are not ended.

`auth:prune-tokens` deletes only what expired; it ends no valid sign-in.

## Sign-ins

By default the framework knows only sessions, and a session does not say whose it is on which browser. Sign-in tracking is opt-in:
it keeps one row per browser a user is signed in on, so the user can see them and sign out of one.

To switch it on, write the migration of the table, run it, and bind the store:

```sh
pnpm marmeon make:sign-ins-table
pnpm marmeon migrate
```

```ts title="modules/auth/AuthServiceProvider.ts"
import { DatabaseSignIns, SignInStore } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(SignInStore, DatabaseSignIns);
  }
}
```

Without the binding `auth.signIns()` and `auth.endSignIn()` throw and `Auth` keeps no rows. The starter kit and the web app bind it.

A row is the authority over its sign-in. The session carries only the row's random id (128 bits), and every request checks that the row
is still there, with every session driver: a session whose row is gone ends at its next request, and so does its remember-me cookie,
which hangs on the same row. That is the end of a single session ASVS 7.5.2 asks an app to offer.

| Column | What it holds |
| --- | --- |
| `id` | 22 characters of base64url, the only thing the session stores. |
| `user_id` | The account; the rows go with it (`cascadeOnDelete()`). |
| `user_agent` | The browser's `User-Agent`, cleaned of control characters and cut to 255 characters. |
| `remember_selector`, `remember_until` | The selector of the browser's [remember-me](#remember-me) token and when it ends, or `null`. |
| `signed_in_at` | The sign-in, or the sign-in by remember-me cookie that continued the row. |
| `last_seen_at` | The last request, exact to 5 minutes: it is written at most that often, so most requests write nothing. |

No IP address is stored. A list of places needs a lookup of the address, and a table of addresses is personal data that nothing else in
the framework needs. An app that keeps an audit log takes the address from the [`Login` event](#events), which carries `ip` and
`userAgent`.

### Listing and ending sign-ins

`auth.signIns()` returns the browsers of the signed-in user: the current one first, marked `current`, then the others by last request.
Each entry has `id`, `current`, `remembered`, `signedInAt`, `lastSeenAt`, `createdAt`, `userAgent` and `device`. `device` is what
`describeDevice()` makes of the `User-Agent`: `{ browser, system }`, each `undefined` when it is not a known one, so the page words it
in its own language. It is a guess and a client can write what it likes in the header.

The list leaves out a sign-in whose session is over: one that has been idle longer than `SESSION_LIFETIME` or began longer ago than
`AUTH_SESSION_MAX_HOURS`, unless a valid remember-me cookie keeps it (`remembered`). Those rows stay in the table until
[pruned](#pruning-sign-ins).

`auth.endSignIn(id)` signs the user out of one of them. It returns a `Result`: `missing` for an id that is unknown, malformed or
another user's (the same answer for all three), and `current` for the browser that asks, which signs out with `logout()`. The route
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
    // `missing` (unknown, malformed or another user's) and `current` (this browser: `logout()` is its way out) end nothing;
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

- `logout()` ends the row of this browser, and a sign-in over another sign-in ends the row it replaces.
- A new password with `updatePassword()`, `logoutOtherDevices()` and `updateSessionKey()` end the rows of every other device and keep the
  current one. This happens after the new key is stored; a failure is logged, and the sessions are over by their fingerprint anyway.
- A password reset ends every row of the user, since it has no session of its own to keep.
- Each of these also closes the account's open live streams, after the commit of the request's transaction.
- [`AccountSessions.end()`](#ending-every-session-of-a-user) ends every row of the user.
- A copied remember-me cookie ends every row of the user, as it ends all their sessions. A token refused for its age (`AUTH_REMEMBER_DAYS`) or for predating the second factor, and one that is already deleted, take their row with them. A token past its end is only rejected and leaves its row, which `prune` removes; a row ended from the list ends its token on its next use.

`UserSessions.end()` alone does not touch the rows.

### Pruning sign-ins

A row of a browser that never came back stays in the table. `marmeon auth:prune-tokens` deletes exactly the rows the list does not
show, for every user, together with the expired tokens; with a bound `SignInStore` its output counts them. It uses `SESSION_LIFETIME`
and `AUTH_SESSION_MAX_HOURS`, so it is the one command to schedule.

### Switching it on for a running app

A session that is open when the store gets bound is given its row at its next request, so nobody is signed out. A remember-me cookie
made before has no row, and a cookie without a row never signs in: those devices sign in once more by password.

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

## Your own stores

`PasswordResetTokenStore`, `AccessTokenStore` and `TwoFactorState` are abstract classes. The class is the contract and the key you bind it under: `container.singleton(AccessTokenStore, YourTokens)` and a constructor that
asks for an `AccessTokenStore` work as they always did. A store of your own extends the class, calls `super()` and implements every method:

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
a structural copy would break at the first call of the new member. Extend the classes of the framework only where they are abstract: the
stores it ships (`DatabaseAccessTokens`, `DatabasePasswordResetTokens`, `TwoFactorStore`, `PasskeyStore`) are implementations, and an
override of one of their methods can break the guarantee of another.

The ids these stores take are `AuthUserId`, the type of `id` in your [`AuthTypes`](#the-user-type-and-where-users-come-from) user: a
number if your users have a number, a string for UUIDs.

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
   hide a way in from the account's owner that the owner could otherwise see and end (so `SignInStore.list` is security-relevant).

When in doubt, a member is security-relevant. What is none of these is display metadata (a device name, "last seen"), statistics,
tidying up rows that are no longer valid and could not become valid again through any setting, and hints for performance. A security-relevant member arrives
after 1.0 only as a security hardening (which may break in a minor version and has its own entry in `UPGRADING.md`) or in a major version.
Any other new member arrives as a method with a default. `UserProvider` and `Hasher` are interfaces; a security-relevant member is added
to them the same way, and any other member is optional, with the behaviour when it is missing documented.

## The tables of the stores

The default stores keep their rows in `remember_tokens`, `password_reset_tokens`, `personal_access_tokens`,
`two_factor_authentications` with `two_factor_recovery_codes`, `passkeys` and `sign_ins`; the starter
kit's migrations create them. `users` is your app's own table. Column marks stay with the
tables: the hashes, the validators and the authenticator's secret are `secret()` columns, so `selectAll()` and relations never return them.

`/up/ready` is red until every table of a store the app uses has the columns the store needs, and says which command to
run. A table counts as used when its store is the database one: remember-me while `AUTH_REMEMBER_DAYS` is above 0, the reset links and
the API tokens once the app has a `UserProvider`, the sign-ins when `SignInStore` is bound, the second factor when `TwoFactorState` is
or contains the `TwoFactorStore`, and the passkeys with the `PasskeyServiceProvider`. A store of your own keeps its own table, and
readiness waits for none of ours: an app that wants no reset links or no API tokens binds a store of its own for them
(`container.singleton(AccessTokenStore, MyTokens)`), because with a `UserProvider` the default stores count as used. Readiness is also red
while a column that holds a secret (`token_hash`, `validator_hash`, `secret`, `code_hash`) lacks its `secret()` mark, as in a table made by hand.

An app that created the tables under their old names (`remember_tokens`, `sign_ins`, …) renames them with
[`marmeon make:upgrade-migrations`](migrations.md#upgrading-the-frameworks-tables), and [stops every process of the old release](deployment.md#the-upgrade-that-stops-every-process) for the
`marmeon migrate` that follows. The rows stay: passwords, authenticators, recovery codes, passkeys and reset links keep working.

## Signed-in pages are never cached

While someone is signed in, every answer of the `web` group goes out with `Cache-Control: no-store, private`: pages, their JSON
for client-side visits, redirects and error pages. Without it, the browser would keep them in its cache, and Back after signing out
would show them again without asking the server. The middleware, `NoStoreWhenSignedIn`, asks the session and never loads the user.
Every app with `@marmeon/auth` has it.

A route that sets its own `Cache-Control` keeps it, such as one with `cacheControl('private, max-age=60')`. Then its answer may
stay in the browser after a sign-out: set your own header only on answers that hold nothing of the user. An app that does keep such answers signs out with `history.clear({ siteData: ['cache', 'storage'] })` after `logout()`, which asks the browser to drop its cache too; the [client features](client-features.md#the-browsers-storage-on-sign-out) page has the cost.

## Events

`@marmeon/auth` dispatches these events through the app's event dispatcher:

| Event | When | Fields |
| --- | --- | --- |
| `Login` | `attempt()`, `login()`, a sign-in by the remember-me cookie | `user`, `remember`, `at`, `via` (`attempt`, `login`, `remember` or `passkey`), `ip`, `userAgent` |
| `Logout` | `logout()` | `user` |
| `Failed` | `attempt()` with an unknown identifier or a wrong password | `identifier`, and `user` when the identifier is known |
| `Lockout` | The starter kit's login throttle turns an attempt away, or an account takes no more password sign-ins for the day (once) | `identifier`, `ip` |
| `Registered` | Your registration, after it created the account | `user` |
| `PasswordChanged` | `updatePassword()` | `user`, `revokedTokens` (the API tokens the new password revoked, `0` unless `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`) |
| `PasswordReset` | A reset with a link from the mail | `user`, `revokedTokens` (as for `PasswordChanged`) |
| `EverySessionEnded` | `AccountSessions.endEveryone()`, `auth:end-all-sessions` | `at`, `accounts`, `rememberTokens`, `resetTokens`, `accessTokens`, `signIns` (the counts), see [ending every session of every account](#ending-every-session-of-every-account) |
| `RememberTokenReused` | A [remember-me cookie](#remember-me) that a rotation had replaced came back, however many rotations ago, or a known cookie came with a validator that was never issued: it was copied | `user`, `at`, `ip`, `userAgent`, `sessionsEnded` |
| `TwoFactorEnabled`, `TwoFactorDisabled`, `RecoveryCodesGenerated`, `RecoveryCodeUsed`, `TwoFactorChallengeFailed` | The second factor of an account changes or is used | See [two-factor authentication](two-factor-authentication.md#events) |

`Failed` carries what was typed as the identifier, never the password. Use it for an audit log, and never show it to the client:
it tells whether the address has an account. The `ip` and `userAgent` of `Login` are the request's, the address resolved through
`TRUSTED_PROXIES` like `ctx.ip`, unless the call to `attempt()` or `login()` passed others. Outside a request they are `null`.
`RememberTokenReused` is dispatched once for each copied cookie, after the user's remember-me tokens were deleted and their sessions ended (or could not be, see `sessionsEnded`), and only for an account that still exists. Its `ip` and `userAgent` belong to the request that presented the old or never-issued value: whoever holds the copy, possibly the thief, or, more rarely, the owner's browser that missed the response carrying a renewal (a cancelled load, a dropped connection), so a mail should say so. A cookie that is no longer the current or just-replaced one cannot come from a browser that kept up with the rotations, so the owner is told for every old copy. `ip` is `null` when it is not an address, `userAgent` has its control characters removed and is cut to 512 characters, and `sessionsEnded` is `false` when the `UserProvider` could not end the sessions (the tokens are gone either way). The event never carries the cookie or a token. The `userAgent` is text the client chose: show a parsed browser and system (`describeDevice()`) in a mail, not the raw header. A queued listener gets `{ userId, at, ip, userAgent, sessionsEnded }`, with `at` as an ISO 8601 string. The starter kit mails the owner.
A queueable event's payload has a name — `RememberTokenReusedPayload`, `LoginPayload` and so on, each the same as `EventPayload<typeof …>` of its class.

`Lockout` and `Registered` are dispatched by your app's code, the starter kit's controllers, not by the package.

A listener reacts to a sign-in without the auth module knowing about it:

```ts title="modules/user-profile/listeners/RecordLastLogin.ts"
import type { Login } from '@marmeon/auth';
import { LoginActivityRepository } from '../LoginActivityRepository.ts';

export class RecordLastLogin {
  readonly #activity: LoginActivityRepository;

  constructor(activity: LoginActivityRepository) {
    this.#activity = activity;
  }

  async handle(event: Login): Promise<void> {
    await this.#activity.record(event.user.id, event.at);
  }
}
```

The module registers it with `listeners: [listen(Login, RecordLastLogin)]`. `Login` and `Registered` can also be queued. A queued
listener of `Login` gets `{ userId, remember, via, at, ip, userAgent }`, with `at` as an ISO 8601 string, and one of `Registered`
gets `{ userId }`. It reads the account as it is when it runs. The [events](events.md#queued-listeners) page explains queued
listeners.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_SESSION_MAX_HOURS` | `24` | The longest a sign-in lasts in hours, however active: 1 to 720. A valid remember-me cookie signs in again. See [how long a sign-in lasts](#how-long-a-sign-in-lasts). |
| `AUTH_REMEMBER_DAYS` | `30` | Days the remember-me cookie keeps a user signed in, from the sign-in: 0 to 30. `0` turns remember me off: no cookie signs in. |
| `AUTH_REMEMBER_COOKIE` | `marmeon_remember` | The name of the remember-me cookie: letters, digits, `_` and `-`. Over HTTPS it gets the `__Host-` prefix. |
| `AUTH_PASSWORD_TIMEOUT` | `900` | Seconds a typed password or a proven passkey counts for `confirmedPassword()`. |
| `AUTH_RESET_EXPIRE` | `60` | Minutes a password reset link works. See [password reset](passwords.md#configuration). |
| `AUTH_RESET_THROTTLE` | `60` | Seconds before another reset link goes to the same address. |
| `AUTH_TOKEN_PREFIX` | `marmeon_` | The prefix of API tokens. See [API tokens](api-tokens.md#the-token-format). |
| `AUTH_PRIVATE_REGISTRATION` | `true` | The private registration of the starter kit. See [starter kit](starter-kit.md#private-registration). |
| `AUTH_UNVERIFIED_DAYS` | `7` | Days before `auth:prune-unverified` deletes an account without a confirmed address. See [email verification](verification.md#unconfirmed-accounts). |
| `APP_NAME` | none | The app's name shown by authenticator apps next to the code. Two-factor setup needs it. See [two-factor authentication](two-factor-authentication.md#setting-up). |
| `AUTH_PASSKEY_RP_ID` | host of `APP_URL` | The RP ID of [passkeys](passkeys.md#requirements): a parent domain of every allowed origin. Checked when passkeys are first used. |
| `AUTH_PASSKEY_ORIGINS` | origin of `APP_URL` | The origins [passkeys](passkeys.md#requirements) are accepted from, comma-separated and exact: `https:`, or `http://localhost`. |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | `false` | `true`: a new password, set by the user or by a reset, revokes every API token of the user. Only `true` and `false` start. See [API tokens](api-tokens.md#revoking-every-token-with-a-new-password). |

The numbers are whole numbers of at least 1; `AUTH_RESET_THROTTLE` and `AUTH_UNVERIFIED_DAYS` may be `0`. A value outside its
range stops the start. The `HASH_*` variables are on the [hashing](hashing.md#configuration) page.

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
