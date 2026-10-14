# Two-Factor Authentication

## Introduction

A password alone is one thing an attacker has to learn. Two-factor authentication adds a second: a six-digit code from an
authenticator app on the user's phone, which changes every 30 seconds. `@marmeon/auth` brings the check, the setup, one-time
recovery codes and the sign-in step in between. A [passkey](passkeys.md) can be the second factor too. The [starter kit](#in-the-starter-kit) brings the pages: the code step of the sign-in and a settings page. The example app in `apps/web-app` shows them grown further.

Two-factor authentication is optional per user, and the framework never forces it. An account that set up an authenticator app
needs the code after its password. An account that did not signs in as before. Nothing here switches itself on for the whole
app: you bind a source of factors once ([Setting up](#setting-up)), and each user decides for their own account.

What it adds to a sign-in:

- **One entry, no way around it.** `auth.attempt()` and `auth.login()` are the only ways to sign a user in by password or by code,
  and both stop at an account with a second factor. The user is signed in only after the code.
- **Codes work once.** A code that was accepted, and every older one, is refused afterwards, also when two requests send it at the
  same moment.
- **Guessing is slow.** Five tries a minute, twenty an hour and fifty a day for each account, counted before the code is looked at.
- **The key is encrypted.** The authenticator's secret is stored with the [app key](encryption.md) and bound to its account.

## Setting up

The package keeps the state in two tables, which your app owns: `two_factor_authentications` (one row per user: the encrypted
secret, when it was confirmed, the last accepted step) and `two_factor_recovery_codes` (a hash and a `used_at` per code). The
`user_id` references your users table. Add both, and tell the framework where to look for factors, in a provider of your auth
module:

```ts title="modules/auth/migrations/2026_10_13_120000_create_two_factor_authentications_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('two_factor_authentications', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete().unique();
      table.text('secret').secret(); // encrypted
      table.timestamp('confirmed_at').nullable(); // null: set up, not confirmed yet
      table.bigInteger('last_used_step').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('two_factor_authentications'),
});
```

```ts title="modules/auth/migrations/2026_10_13_120100_create_two_factor_recovery_codes_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('two_factor_recovery_codes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('code_hash', 64).secret(); // only the hash of a code
      table.timestamp('used_at').nullable();
      table.timestamps();
      table.unique(['user_id', 'code_hash']);
    }),
  down: (schema) => schema.drop('two_factor_recovery_codes'),
});
```

```ts title="modules/auth/AuthServiceProvider.ts"
import { combineFactors, TwoFactorState, TwoFactorStore } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore)));
  }
}
```

`TwoFactorState` answers which factors an account has (`factors()`) and since when (`enabledSince()`, the earliest confirmation). Without a binding it says "none" and asks nothing, so an app that does
not bind it behaves exactly as before. Removing the binding later switches two-factor authentication off for every account: users
who set it up sign in with the password alone. `combineFactors()` joins several sources into one: the authenticator app is `TwoFactorStore`,
and [passkeys](passkeys.md) add `PasskeyStore` (`combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore))`). Recovery codes belong to the
account, whichever factor made them.

The authenticator app shows the app's name next to the code. It comes from `APP_NAME`, which every app already sets; `begin()`
throws a clear error when it is missing.

Handle the new case in the controller that signs in. When the password is right and the account has a second factor,
`attempt()` returns an `err` of kind `two-factor-required`, nobody is signed in, and the session waits for the code:

```ts title="modules/auth/controllers/LoginController.ts"
const signedIn = await this.#auth.attempt(email, password, { remember });
if (!signedIn.ok) {
  if (signedIn.error.kind === 'two-factor-required') return this.redirect().route('auth.two-factor.challenge');
  throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
}
```

An app that does not handle the case still never signs anybody in without the code; at worst its login page says that the
sign-in failed. `auth.login(user)` has the same fork: it returns `'signed-in'` or `'two-factor-required'`, and also then the account
is not signed in. Pages of the app need nothing else: `ctx.user`, `authenticate()` and the shared props see a guest until the code
was accepted.

The settings page of a user calls `TwoFactor` from `@marmeon/auth/two-factor`:

```ts title="modules/auth/controllers/BeginTwoFactorController.ts"
import { TwoFactor } from '@marmeon/auth/two-factor';

const setup = await this.#twoFactor.begin(); // { secret, uri, qr }
```

`begin()` needs a signed-in user who typed the password within 15 minutes by default (the [`confirmedPassword()`](authentication.md#sudo-mode)
middleware) and returns a new key: `secret` to type in, `uri` for the `otpauth://` link and `qr`, the QR code as `{ size, path }`.
Render it as an SVG with a quiet zone of white around the modules, because scanners need one and a dark theme would take it away:

```tsx
<svg viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} width="192" height="192" role="img" aria-label="QR code">
  <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" />
  <path d={qr.path} fill="#000" />
</svg>
```

The page needs neither `innerHTML` nor a `style` attribute. The key is not in force yet. `setup()` returns the same key again for a reloaded page, and `begin()` replaces an
unconfirmed key.

`begin()` throws when no source of factors is bound (`TwoFactorState` is still the default that knows none), and for an account
without a password: turning the factor on signs the other devices out, which takes the password hash.

The user types the first code the app shows and the account's password into one form: `confirm(code, password)`. It returns a
[`Result`](errors.md#results): `ok` with `recoveryCodes`, or an `err` of kind `not-started`, `invalid-password`, `invalid-code` or
`throttled`. A wrong password with the right code changes nothing and does not use the code up. Only a right pair turns the factor
on, and then:

- **The other devices are signed out.** Their sessions end and so do their [remember-me](authentication.md#remember-me) tokens:
  every session of the account has then proven a second factor. This session stays and gets the new fingerprint, the way
  [`logoutOtherDevices(password)`](authentication.md#changing-the-password) does it, without a second password check. The signing out
  runs twice, before the factor is switched on and again right after, so that a sign-in racing the activation does not survive it.
  Say so on the page before the user submits.
- **API tokens are not revoked.** They are integrations of your app, such as scripts and CI, and revoking them is your decision. List
  them in the answer and link to where they are revoked, as the example app does.
- **Recovery codes** are made when this is the account's first factor (see [Recovery codes](#recovery-codes)).
- **This session** counts as having proven the factor.

A remember-me token made before the factor was confirmed is refused, also one that another device made in the moment between
signing out and switching the factor on: `TwoFactorState.enabledSince()` says since when the account has a factor, and an older
token never proved one (a token made in the same millisecond counts as older). The token and cookie of the device that turned it on go
too, as after a password change: its next sign-in makes a new one after the code. A password sign-in that reads "no factor" just before
the commit and finishes after it is taken back: the factors are read again once the session exists, and a factor that has appeared
then ends that sign-in, its remember-me token included.

## The sign-in

After the password, `GET /two-factor-challenge` asks for the code, and `POST` sends it to `TwoFactor.challenge()`. The same method takes a passkey's
response, `challenge({ passkey })`, which is explained on the [passkeys](passkeys.md#as-a-second-factor) page:

```ts title="modules/auth/controllers/TwoFactorChallengeController.ts"
const done = await this.#twoFactor.challenge(recoveryCode !== '' ? { recoveryCode } : { code });
if (done.ok) return this.redirect().intended().route('user-profile.me');
```

`challenge()` returns the signed-in user or an `err`:

| `kind` | Meaning |
| --- | --- |
| `no-challenge` | No sign-in waits for a code. Show the login page. |
| `expired` | The wait ended: more than five minutes, or a changed password or session key, or a deleted account. The password has to be typed again. |
| `invalid-code` | The code is wrong, was used before or belongs to a factor that is off. `attemptsLeft` says how many wrong tries remain. |
| `throttled` | Too many tries for this account. `retryAfter` is in seconds. |

The fifth wrong code answers `invalid-code` with `attemptsLeft: 0` and drops the waiting sign-in at the same time; the next call
answers `no-challenge`. So send the user back to the login page at `attemptsLeft: 0`, as the example app does with a hint. The
checks run in this order: the waiting sign-in and its account, the throttle, the code. A sign-in that ended is refused before
any code is used up. On success the user is signed in with a new session id, the `Login` event is dispatched, and the
[remember-me](authentication.md#remember-me) cookie is made if the user asked for it at the login: before the code, nothing is
remembered.

The limits are constants of the package, not settings: a six-digit code is guessable in hours without them, and loosening them is a
code review rather than a deploy switch. Route the `POST` with `.block()`, so that two codes of one session cannot run at once. A right code clears only the minute counter, so that the hour and day counters keep what
guessing used up. Challenge and `confirm()` share the counters, which are per account. A password reset gives no fresh attempts: whoever took over
the mailbox could otherwise ask for one and start over. Recovery codes have a counter of their own, ten a minute and nothing more,
because 80 bits cannot be guessed: it only limits load.

The counters live in the [cache](cache.md). With `CACHE_DRIVER=memory` every process counts for itself, so several processes
multiply each limit; use the Redis or database driver wherever more than one process serves requests.

A code is accepted for the 30-second step it was made in and one step on either side, which covers a small clock difference.
Keep the server's clock right with NTP. The step of an accepted code is stored, and any code of the same or an older step is
refused afterwards.

## Recovery codes

When the first factor is confirmed, the account gets ten recovery codes, shown as `XXXX-XXXX-XXXX-XXXX`. Each works once instead of
a code from the app, for a user whose phone is gone. They are shown in the response that made them and never again. Answer with a
[layer](dialogs.md#back-forward-and-closing) over the settings page that replies to the `POST`, as the example app does for its
API tokens: the codes then never sit in the session, they are gone from the tab's memory when the layer closes, and Forward
asks the URL with a `GET` that must not show them. Do not redirect with them in a flash message. The database keeps only their hashes.

`challenge({ recoveryCode })` accepts a code typed in lower case or with spaces. A spent code is refused. `status()` returns
`recoveryCodesLeft`, and the example app asks for new ones when three or fewer remain. `regenerateRecoveryCodes()` makes ten new
codes in place of all the old ones, spent or not; it needs the password typed within 15 minutes by default, like `begin()`.

Recovery codes belong to the account, not to the authenticator app: they stay when another factor is added and go with the last
one. They work even when the secret of the authenticator can no longer be decrypted.

## Changing the factors

On an account that already has a factor, the password is not enough to change its factors. `begin()`, `setup()`,
`regenerateRecoveryCodes()` and `disable()` of `TwoFactor`, and `registrationOptions()`, `register()`, `remove()` and `release()` of
[`Passkeys`](passkeys.md#managing-passkeys) throw unless this session proved a second factor within the last 15 minutes
([how long](authentication.md#how-long-a-sign-in-lasts); not a setting). Without it, a stolen session whose factor was proven more than 15 minutes ago and a phished password would
be enough to add a factor of the thief's own, or to take the owner's away and set up a "first" one. The same holds for the routes that change the e-mail address (a reset link goes to the new one) and create API tokens: guard them too, and for an action of your own that weighs as much, call `twoFactor.requireRecentProof('exportData')` — it throws under the same conditions as the methods above, with the name in the message, and lets an account without a factor through. The starter kit's `UpdateEmailController` calls it itself, so a route added to it by hand cannot skip the check.
An account without a factor
needs only the password for its first one, and finishing a setup with `confirm()` needs no new proof: the code shows the key that a
guarded `begin()` made. `confirm()` also records the proof only for the first factor, since a further factor says nothing about the one
that is already there.

`confirm()` also checks the session against the account in the transaction that stores the factor. When the session ended meanwhile
(another device changed the password, `AccountSessions.end()` or an operator's reset ran), it stores nothing and returns
`{ kind: 'signed-out' }`; send the user to the sign-in. `Passkeys.register()` does the same.

Put `confirmedSecondFactor({ verify })` from `@marmeon/auth/two-factor` beside `confirmedPassword()` on the routes that call these
methods, so that a stale session is sent to the page that asks for the factor again (and comes back) instead of seeing an error:

```ts
const factors = sudo.middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' }));
factors.post('/settings/two-factor/disable', DisableTwoFactorController).name('auth.two-factor.disable');
```

JSON clients get `403 {"error":"two_factor_unverified"}`. Unlike `twoFactor()`, it lets an account without a factor through, so the
setup page stays reachable. An app with its own routes for these methods has to put them behind it; without it the methods throw.

## Turning it off

`disable(password)` (see [Changing the factors](#changing-the-factors) for the proof it needs) checks the password typed now and returns `false` for a wrong one, with nothing changed. With the right one it
removes the authenticator, and the recovery codes with the last factor, and returns `true`. Throttle the password checks in the
caller; the example app uses the same limiter as for its other password checks.

```ts title="modules/auth/controllers/DisableTwoFactorController.ts"
await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'password', () => this.#twoFactor.disable(ctx.body.password));
```

## What it protects against, and what not

It protects against a stolen or guessed password, and a password from another site's leak. It does not protect against a user who
types the code into a copy of your login page that forwards it at once, against someone who already holds a signed-in session or
controls the user's device, or against whoever has the server's `APP_KEY`. A [remember-me](authentication.md#remember-me) cookie
signs in without the code, so it counts as a proven factor only for `maxAge`, counted from the sign-in that made it (24 hours by default). Codes by e-mail or SMS are not offered on purpose.

Someone who knows the password or holds a signed-in session can use up the code attempts for a day; recovery codes stay open, so the owner is not locked out. A
password reset does not clear the counters.
Turning the factor on signs out every other device, so a session that was open before is gone (see [Setting up](#setting-up)).

## Requiring it

Two-factor authentication is a choice of each user. When an area of your app should open only for people who have it, put
`twoFactor()` from `@marmeon/auth/two-factor` behind `authenticate()`:

```ts title="modules/auth/routes.ts"
import { authenticate } from '@marmeon/auth';
import { twoFactor } from '@marmeon/auth/two-factor';
import { everyone } from '@marmeon/http';

const protectedArea = Route.middleware(authenticate())
  .middleware(twoFactor({ setup: 'auth.two-factor', verify: 'auth.two-factor.verify', maxAge: 900 }))
  .authorize(everyone); // the user's own settings
protectedArea.get('/settings/sensitive', ShowSensitiveController);
```

The framework provides this middleware and never installs it: not for a group, not in the starter kit, not through a setting. Where
it runs is your decision, route by route. It refuses by default; each of these is a different answer:

| Who | Browser | JSON client |
| --- | --- | --- |
| Nobody is signed in (also a sign-in that waits for its code, or an API token) | Redirect to the login page | `401` |
| Signed in, the account has no factor | Redirect to `setup`: the page where a factor is turned on | `403` `{ "error": "two_factor_required" }` |
| Signed in, the account has a factor, this session has not proven it, or not within `maxAge` (24 hours by default) | Redirect to `verify` | `403` `{ "error": "two_factor_unverified" }` |
| The session proved its factor | The request goes on | The request goes on |

A browser that is sent away comes back to the page it asked for (`redirect().intended()`). A session proves its factor by
passing the code step of the sign-in, by turning the factor on, or by `stepUp()` below; a remember-me sign-in of an account with
a factor counts as proven at the time its cookie was made (after a code, and kept when the cookie rotates), so an old cookie
(older than `maxAge`, 24 hours by default) sends the session to `verify` too. That holds when `AUTH_SESSION_MAX_HOURS` ends a
sign-in and the cookie signs the user in anew: the new session inherits the cookie's proof time, not the time of the new
sign-in. A session that was open before the factor was added has not proven it, so it is sent to `verify`. The proof stays for 24 hours (`TWO_FACTOR_MAX_AGE` from
`@marmeon/auth/two-factor`), or for `maxAge` seconds when you give one, longer or shorter; then the user is asked again. There
is no setting for "never". [How long a sign-in lasts](authentication.md#how-long-a-sign-in-lasts) lists it with the other lifetimes. Typing the password again ([sudo mode](authentication.md#sudo-mode)) is a different thing and proves nothing
about the second factor.

The `verify` page asks for a code and calls `TwoFactor.stepUp()`, which takes the same input and uses the same throttle, events and
errors as `challenge()`:

```ts title="modules/auth/controllers/TwoFactorVerifyController.ts"
const done = await this.#twoFactor.stepUp(recoveryCode !== '' ? { recoveryCode } : { code });
if (done.ok) return this.redirect().intended().route('auth.sensitive');
```

`stepUp()` changes nothing about the sign-in: a wrong code does not end the session (`attemptsLeft` counts down the minute's tries),
`no-challenge` means the account has no factor to prove, and a right code marks the session as proven under a new session id. It
needs a signed-in user. Route the `POST` with `.block()`, as for the challenge.

An account with a [passkey](passkeys.md#as-a-step-up) proves it the same way: `stepUp({ passkey })` takes the browser's response to the
options of `passkeys.stepUpOptions()`. It uses the generous counter of the recovery codes (ten a minute), not the budget of the code
attempts, and a wrong response fires `TwoFactorChallengeFailed` with `during: 'step-up'` and ends no session (a challenge that timed out or was sent twice is refused without the event, so a mail on it never cries wolf). Without it, an account whose only factor is a passkey
would get through `twoFactor()` only with a recovery code. Give the route of the options a limit of its own.

The middleware reads the session, so it belongs in the `web` group. The stateless `api` group has no session: behind `authenticate('api')`
an API token never counts as a proven second factor, and `twoFactor()` there answers `401`. Tokens are their own credentials; see
[What it protects against](#what-it-protects-against-and-what-not).

## In the starter kit

The [starter kit](starter-kit.md) brings the pages, so a new app has two-factor authentication without writing any. `make:auth`
adds a migration for both tables (`foreignId('user_id').constrained().cascadeOnDelete()`, as the kit's other tables), the
binding `combineFactors(TwoFactorStore, PasskeyStore)` in `AuthServiceProvider.ts` (the [passkeys](passkeys.md#in-the-starter-kit) are the kit's second source), the controllers and routes, and these pages, in both
languages:

| Page | What it does |
| --- | --- |
| `auth/TwoFactorChallenge` | The code step of the sign-in. The recovery code is a second form on the same page, so it also works without JavaScript. |
| `auth/TwoFactor` | In the settings: the status, the QR code and the key, the form that confirms with a code and the password, new recovery codes, turning it off. |
| `auth/RecoveryCodes` | A layer over the settings page, the answer of confirming and of making new codes. The codes are in no page after that. |
| `auth/TwoFactorVerify` | Asks a signed-in session for a code again, for `twoFactor()`. A wrong code ends nothing. |

The QR code is drawn on white, also in the dark mode, because some apps do not scan it otherwise.

The kit puts the settings pages and routes that change factors (the two-factor page, setup, new recovery codes, turning it off, and every
passkey route but renaming) and, for the same reason, changing the e-mail address and creating an API token behind `confirmedSecondFactor()` after sudo mode: a session that has not proven a factor within 15
minutes lands on `auth/TwoFactorVerify` first. Confirming a setup is left out. The kit does not install `twoFactor()`, but it has the routes it needs. To require the factor on a route, add the middleware
to it in `modules/auth/routes.ts`, on a registrar that already says who may call it, such as `confirmedAddress`:

```ts
confirmedAddress.middleware(twoFactor({ setup: 'auth.two-factor', verify: 'auth.two-factor.verify' })).get('/reports', ShowReportsController);
```

with `import { twoFactor } from '@marmeon/auth/two-factor';`. After a proven code the verify page sends the user back to the page
that asked, or to the dashboard.

The kit's listeners send the owner a mail on `TwoFactorEnabled`, `TwoFactorDisabled`, `RecoveryCodeUsed` and, for
`during: 'sign-in'`, on `TwoFactorChallengeFailed`, the last at most once an hour for each account. `marmeon auth:reset-two-factor <email> --force` is the
[operator reset](#operator-reset) as a command: it ends every session and remember-me cookie of the account, calls `removeAll()` and dispatches `TwoFactorDisabled` with `via: 'operator'`.

## Events

| Event | When | Fields |
| --- | --- | --- |
| `TwoFactorEnabled` | `confirm()` turned a factor on | `user`, `factor` |
| `TwoFactorDisabled` | `disable()` or the operator's reset | `user`, `via` (`user` or `operator`) |
| `RecoveryCodesGenerated` | The first factor, or `regenerateRecoveryCodes()` | `user` |
| `RecoveryCodeUsed` | A recovery code signed in or stepped up | `user`, `remaining` |
| `TwoFactorChallengeFailed` | A wrong factor (code, recovery code or passkey) after a right password (`during: 'sign-in'`), or a wrong code or passkey from a signed-in session at `stepUp()` (`during: 'step-up'`) | `user`, `at`, `ip`, `userAgent`, `during` |

All of them can be [queued](events.md#queued-listeners); a queued listener gets `userId` and the other fields as JSON. Send the
owner a mail on `TwoFactorChallengeFailed` ("someone knew your password" for `during: 'sign-in'`, "a code was guessed in your session" for `'step-up'`), on `TwoFactorDisabled` and on `RecoveryCodeUsed`.

## Testing

A test that acts as a user with `actingAs()` skips two-factor authentication on purpose: the session counts as having proven the
factor when the account has one, so a page behind `twoFactor()` opens for it, and an account without a factor is still sent to set
one up. To test the code step, sign in for real and compute the code the authenticator would show with `twoFactorCode()`:

```ts title="modules/auth/two-factor.test.ts"
import { twoFactorCode } from '@marmeon/auth';

const setup = (await app.withCookie('marmeon_session', cookie).navigating().get('/settings/two-factor')).page()!.props.setup;
await app.withCookie('marmeon_session', cookie).post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } });
```

`twoFactorCode(secret, at?)` takes the key `begin()` returned. A code works once, so a second sign-in in the same test needs a code of
the next step: `twoFactorCode(secret, new Date(Date.now() + 30_000))`.

## Operator reset

A user who lost both the phone and the recovery codes has to be let in by an operator, who must be sure it is the owner. There is
no built-in command for it (the starter kit has one); `TwoFactorStore.removeAll(userId)` removes the authenticator and every recovery code of an account,
for example from a command of your own. `removeAll()` dispatches nothing: the command dispatches `TwoFactorDisabled` with
`via: 'operator'` itself, so that listeners (the mail to the owner, an audit log) hear of it.

End the sessions of the account in the same command with [`AccountSessions.end()`](authentication.md#ending-every-session-of-a-user): an account without a
factor lets a signed-in session enrol one, so a session on the lost device, or an attacker's, would own the account. The starter
kit's command does it before it removes the factors, and exits with 1 when the account is gone or when a factor was enrolled while it ran (run it again). The password alone signs in afterwards: if a compromise is suspected, have the owner reset the password as well.

## Key rotation

The secret is encrypted with `APP_KEY`. After you rotate the key, list the old one in `APP_PREVIOUS_KEYS` (see
[encryption](encryption.md)); a secret that was encrypted with an earlier key still works, and every accepted code stores it
again with the current key. Recovery codes do not depend on `APP_KEY`.
