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
import { Repository, secret } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  findForLogin(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    await this.update(id, { password: hash });
  }

  async #credentials(query: ReturnType<UserRepository['query']>): Promise<Credentials<User> | undefined> {
    const row = await query.selectAll().select((eb) => secret(eb, 'password')).executeTakeFirst();
    if (!row) return undefined;
    const { password, ...user } = row;
    return { user, passwordHash: password as PasswordHash };
  }
}
```

`Credentials` is `{ user, passwordHash }`: the hash travels next to the user, never inside it, so it cannot reach a page by
accident. A user who cannot sign in with a password has `passwordHash: null`. `Credentials` may also carry a `sessionKey`, a value of
the account that ends its other sessions when it changes, as [signing out without a password](#signing-out-other-devices-without-a-password)
explains. `findForLogin()` gets what the person typed after
the request's schema normalized it; the starter kit's schema trims the address and makes it lower case. Until a provider is
bound, the first use of `UserProvider` throws an error that says how to bind one.

## Protecting routes

The package brings four middleware for the routes of the `web` group:

| Middleware | Lets through | Everyone else |
| --- | --- | --- |
| `authenticate()` | A signed-in user, as `ctx.user`. | A browser goes to the login page, a JSON client gets 401. |
| `guest(home)` | Guests. For the login and registration pages. | A redirect to `home`, `/` by default. |
| `verified()` | A user whose `email_verified_at` is set. After `authenticate()`. | A browser goes to the notice, `auth.verification.notice`. A JSON client gets 403. |
| `confirmedPassword()` | A user who typed the password within the last 15 minutes. After `authenticate()`. | A browser goes to `auth.password.confirm`, a JSON client gets 423. |
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
import { RateLimiter } from '@marmeon/cache';
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
    const key = `login:${email}|${ctx.ip ?? 'unknown'}`;
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
fails. Neither the answer nor its duration tells a stranger which addresses have an account.

`two-factor-required` comes only after a correct password, for an account that set up a [second
factor](two-factor-authentication.md). Nobody is signed in then: no `Login` event, no remember-me cookie, `auth.user()` is
`undefined`. The session keeps the right password for five minutes, `auth.pendingSecondFactor()` names the factors it waits for,
and the error carries them as `factors`. Redirect to the page that asks for the code. An app that ignores the case still signs
nobody in. Without a source of factors bound (see [Setting up](two-factor-authentication.md#setting-up)) the case never happens. When the stored hash was made with other costs than the
configured ones, `attempt()` hashes the password again and stores the new hash. It also notes the time, so the password counts as
just confirmed for [sudo mode](#sudo-mode).

The limit is counted before the password is checked, in one atomic step: guesses sent at the same moment cannot all slip under
it. Five failed attempts a minute for one address from one client lock it for the rest of the minute. The
[rate limiting](rate-limiting.md#defining-limiters) page covers limiters.

`login(user)` signs a user in without a password, for example right after a registration. It returns `'signed-in'`, or
`'two-factor-required'` for an account with a second factor: that account is not signed in, exactly as with `attempt()`. A
registration signs in a new account, which has no second factor, so its result needs no handling there. Both methods do the same
to the session:

- **A new session.** The session gets a new id and a new CSRF token, and keeps its data. An id handed out before the sign-in signs
  nobody in: this stops session fixation.
- **A fingerprint, not the hash.** The session keeps a SHA-256 of the account's id, password hash and session key, never the hash
  itself. Two accounts never share one, also without a password.
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

## Remember me

`attempt(email, password, { remember: true })` keeps the user signed in on this device after the session has expired. The browser
gets a cookie, `remember_web`, that is encrypted, `HttpOnly`, and `Secure` and `SameSite` like the session cookie. It is valid for
`AUTH_REMEMBER_DAYS` days from the sign-in, 30 by default, and using it never extends it.

The cookie is consulted only when the session has no user. It holds a selector and a secret validator. The `remember_tokens`
table keeps one row per device, with the validator only as its SHA-256 hash, so a leaked table signs nobody in. A table of your
own needs what the starter kit's migration gives it: a unique `selector` of up to 32 characters, the validator hashes as
64-character `secret()` columns, and `user_id` with `cascadeOnDelete()`, so a deleted user's tokens go with the account.

- **Every use rotates the validator.** The cookie gets a new value, and the old one stops working. A second tab that sends the old
  value within 60 seconds of the rotation still passes.
- **A copied cookie ends every token.** An old validator that comes back later means two browsers hold the same cookie. Every
  remember-me token of that user is deleted, and the app logs a warning.
- **Requests that only read never use it.** An island cannot sign in: rotating the token there would hand the new value to no
  one. The next page request signs in.

To keep the tokens somewhere else than the table, bind your own `RememberTokenStore`. Its `consume()` returns `createdAt` with the device: when the token was made, kept over every rotation. A token made before the account's [second factor](two-factor-authentication.md#setting-up) was confirmed is refused by it.

## Sudo mode

Some pages ask for the password again even though the user is signed in, such as the page with the API tokens.
`confirmedPassword()` lets a user through who typed the password within the last `AUTH_PASSWORD_TIMEOUT` seconds, 15 minutes by
default:

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

Everyone else goes to `auth.password.confirm`, and after the confirmation back to the page they asked for. A JSON client gets
`423 {"message":"Password confirmation required."}`. `confirmedPassword({ confirmRoute, seconds })` names another page or another
time.

The confirmation page posts the password to `auth.confirmPassword(password)`, which checks it and notes the time. For a user
without a password it takes as long and returns `false`. `attempt()` notes the time as well; `login()` does not, since nobody
typed a password.

The starter kit allows five wrong passwords a minute per user across the confirmation, the password change and "sign out other
devices". A stolen session must not become a way to guess the password.

## Changing the password

`updatePassword(password)` stores a new hash for the signed-in user. This session stays signed in. Every other session ends at its
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
    await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'current_password', () => this.#auth.confirmPassword(ctx.body.current_password));
    await this.#auth.updatePassword(ctx.body.password);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.password_changed') });
  }
}
```

`throttlePasswordChecks()` in `modules/auth/throttle.ts` counts the try before the check, at most five a minute per user, and
throws a field error for a wrong password. Never check a signed-in user's password without such a limit. The handler's
`& Authenticated` types the context: `ctx.user` is there because the route sits behind `authenticate()`. The
[hashing](hashing.md#the-password-rule) page explains the `password()` rule.

`logoutOtherDevices(password)` signs out every other device without changing the password. It checks the password, returns `false`
when it is wrong, and otherwise hashes it again with a new salt. The other sessions end at their next request, and the
remember-me tokens of the other devices are deleted.

The starter kit runs both routes with `.block()`: one such request per session at a time. Two at once could leave the session
with the fingerprint of the other request's hash, and sign it out. The [session](session.md#requests-that-must-not-overlap) page
explains `block()`.

### Signing out other devices without a password

An account that signs in by a link or through another provider has no password to check. `updateSessionKey()` signs out its other
devices all the same: it draws a new random session key, stores it with `updateSessionKey(id, key)` of your `UserProvider`, and
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
import { Repository, secret } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> implements UserProvider<User> {
  static table = 'users' as const;

  findById(id: number): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('id', '=', id));
  }

  findForLogin(email: string): Promise<Credentials<User> | undefined> {
    return this.#credentials(this.query().where('email', '=', email));
  }

  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    await this.update(id, { password: hash });
  }

  async updateSessionKey(id: number, key: string): Promise<void> {
    await this.update(id, { session_key: key });
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

`updateSessionKey()` checks nothing itself: confirm the user your own way first, such as with a fresh link. Without
`updateSessionKey` on the provider it throws an error that names the method, and it throws as well when `findById()` does not hand
the new key back. It never leaves the other devices signed in while it seems to have worked.

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
    await this.#auth.updateSessionKey();
    return this.back('/settings/security');
  }
}
```

Run such a route with `.block()` as well. `logoutOtherDevices(password)` stays the way for an account with a password: it checks
the password first. An app without session keys keeps its fingerprints of id and hash.

### API tokens

A new password revokes the user's API tokens only with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, and "sign out other devices"
never does. Otherwise a token stays valid until it expires or is revoked on the tokens page. The
[API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains when to turn it on.

## Ending every session of a user

A session signs in with a fingerprint of the account, its id, password hash and session key, and every request compares it with
the account as it is now. When the password or the session key changes anywhere, every other session stops matching and ends at
its next request. When the user is deleted, the lookup
finds nobody, and the session ends the same way. A request that only reads, such as an island, treats such a session as a guest
and leaves the ending to the next page request.

`UserSessions` of `@marmeon/session` ends a user's sessions at once. Deleting an account needs it, and the starter kit's
`AccountDeletion` calls it after the account is gone:

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

`end(id)` returns how many sessions it ended. Only the `database` driver can find a user's sessions, by the `user_id` column of its
table, and removes them. The other drivers cannot tell whose a session is, so `end()` returns `0` there: for a deleted account
that does no harm, since its sessions end at their next request. For a user who still exists, a new fingerprint ends the other
sessions with every driver: a new password, `logoutOtherDevices(password)` or `updateSessionKey()`. `end(id)` stays the way to
end every session of a user at once, the current one included, and only with the `database` driver.

## Signed-in pages are never cached

While someone is signed in, every answer of the `web` group goes out with `Cache-Control: no-store, private`: pages, their JSON
for client-side visits, redirects and error pages. Without it, the browser would keep them in its cache, and Back after signing out
would show them again without asking the server. The middleware, `NoStoreWhenSignedIn`, asks the session and never loads the user.
Every app with `@marmeon/auth` has it.

A route that sets its own `Cache-Control` keeps it, such as one with `cacheControl('private, max-age=60')`. Then its answer may
stay in the browser after a sign-out: set your own header only on answers that hold nothing of the user. An app that does keep such answers signs out with `history.clear({ siteData: ['cache', 'storage'] })` after `logout()`, which asks the browser to drop its cache too; the [client features](client-features.md#the-browsers-storage-on-sign-out) page has the cost.

An app with sign-in needs a session driver that keeps the sessions on the server. With `SESSION_DRIVER=cookie`, a request still
running during a sign-out brings the signed-in cookie back with its answer, and the app warns about it at start-up. The
[session](session.md#the-cookie-driver) page explains why.

## Events

`@marmeon/auth` dispatches these events through the app's event dispatcher:

| Event | When | Fields |
| --- | --- | --- |
| `Login` | `attempt()`, `login()`, a sign-in by the remember-me cookie | `user`, `remember`, `at`, `via` (`attempt`, `login`, `remember` or `passkey`), `ip`, `userAgent` |
| `Logout` | `logout()` | `user` |
| `Failed` | `attempt()` with an unknown identifier or a wrong password | `identifier`, and `user` when the identifier is known |
| `Lockout` | The starter kit's login throttle turns an attempt away | `identifier`, `ip` |
| `Registered` | Your registration, after it created the account | `user` |
| `PasswordChanged` | `updatePassword()` | `user`, `revokedTokens` (the API tokens the new password revoked, `0` unless `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`) |
| `PasswordReset` | A reset with a link from the mail | `user`, `revokedTokens` (as for `PasswordChanged`) |
| `TwoFactorEnabled`, `TwoFactorDisabled`, `RecoveryCodesGenerated`, `RecoveryCodeUsed`, `TwoFactorChallengeFailed` | The second factor of an account changes or is used | See [two-factor authentication](two-factor-authentication.md#events) |

`Failed` carries what was typed as the identifier, never the password. Use it for an audit log, and never show it to the client:
it tells whether the address has an account. The `ip` and `userAgent` of `Login` are the request's, the address resolved through
`TRUSTED_PROXIES` like `ctx.ip`, unless the call to `attempt()` or `login()` passed others. Outside a request they are `null`.
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
| `AUTH_REMEMBER_DAYS` | `30` | Days the remember-me cookie keeps a user signed in, from the sign-in. |
| `AUTH_REMEMBER_COOKIE` | `remember_web` | The name of the remember-me cookie: letters, digits, `_` and `-`. |
| `AUTH_PASSWORD_TIMEOUT` | `900` | Seconds a typed password counts for `confirmedPassword()`. |
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

`UserFactory` makes users with a confirmed address. `actingAs()` needs a session driver on the server; a new app's `.env.test`
sets `SESSION_DRIVER=memory`. The [HTTP tests](http-tests.md#sessions-and-signing-in) page shows the assertions for sessions,
sign-in and sign-out.
