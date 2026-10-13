# Two-Factor Authentication

## Introduction

A password alone is one thing an attacker has to learn. Two-factor authentication adds a second: a six-digit code from an
authenticator app on the user's phone, which changes every 30 seconds. `@marmeon/auth` brings the check, the setup, one-time
recovery codes and the sign-in step in between. The example app in `apps/web-app` shows the pages: the code step of the sign-in and a settings page.

Two-factor authentication is optional per user, and the framework never forces it. An account that set up an authenticator app
needs the code after its password. An account that did not signs in as before. Nothing here switches itself on for the whole
app: you bind a source of factors once ([Setting up](#setting-up)), and each user decides for their own account.

What it adds to a sign-in:

- **One entry, no way around it.** `auth.attempt()` and `auth.login()` are the only ways to sign a user in by password or by code,
  and both stop at an account with a second factor. The user is signed in only after the code.
- **Codes work once.** A code that was accepted, and every older one, is refused afterwards, also when two requests send it at the
  same moment.
- **Guessing is slow.** Five tries a minute and twenty an hour for each account, counted before the code is looked at.
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

`TwoFactorState` answers which factors an account has. Without a binding it says "none" and asks nothing, so an app that does
not bind it behaves exactly as before. Removing the binding later switches two-factor authentication off for every account: users
who set it up sign in with the password alone. `combineFactors()` joins several sources into one; today the authenticator app is
the only one.

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

`begin()` needs a signed-in user who typed the password recently (the [`confirmedPassword()`](authentication.md#sudo-mode)
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

The user types the first code the app shows into `confirm(code)`. It returns a [`Result`](errors.md#results): `ok` with
`recoveryCodes`, or an `err` of kind `not-started`, `invalid-code` or `throttled`. Only then the factor is on, and:

- **Recovery codes** are made when this is the account's first factor (see [Recovery codes](#recovery-codes)).
- **The other devices** lose their [remember-me](authentication.md#remember-me) tokens. They were made when a password was enough;
  only the device that confirmed keeps its token.
- **This session** counts as having proven the factor.

## The sign-in

After the password, `GET /two-factor-challenge` asks for the code, and `POST` sends it to `TwoFactor.challenge()`:

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
code review rather than a deploy switch. Route the `POST` with `.block()`, so that two codes of one session cannot run at once.

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
codes in place of all the old ones, spent or not; it needs the password typed recently, like `begin()`.

Recovery codes belong to the account, not to the authenticator app: they stay when another factor is added and go with the last
one. They work even when the secret of the authenticator can no longer be decrypted.

## Turning it off

`disable(password)` checks the password typed now and returns `false` for a wrong one, with nothing changed. With the right one it
removes the authenticator, and the recovery codes with the last factor, and returns `true`. Throttle the password checks in the
caller; the example app uses the same limiter as for its other password checks.

```ts title="modules/auth/controllers/DisableTwoFactorController.ts"
await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'password', () => this.#twoFactor.disable(ctx.body.password));
```

## What it protects against, and what not

It protects against a stolen or guessed password, and a password from another site's leak. It does not protect against a user who
types the code into a copy of your login page that forwards it at once, against someone who already holds a signed-in session or
controls the user's device, or against whoever has the server's `APP_KEY`. Codes by e-mail or SMS are not offered on purpose.

Turning the factor on does not end sessions that are already signed in on other devices: it only deletes their remember-me tokens,
so they cannot sign in again once the session is over. A user who suspects that someone else is signed in signs the other devices
out, as [signing out other devices](authentication.md#signing-out-other-devices-without-a-password) and the [password
change](authentication.md#changing-the-password) describe.

## Events

| Event | When | Fields |
| --- | --- | --- |
| `TwoFactorEnabled` | `confirm()` turned a factor on | `user`, `factor` |
| `TwoFactorDisabled` | `disable()` or the operator's reset | `user`, `via` (`user` or `operator`) |
| `RecoveryCodesGenerated` | The first factor, or `regenerateRecoveryCodes()` | `user` |
| `RecoveryCodeUsed` | A recovery code signed in | `user`, `remaining` |
| `TwoFactorChallengeFailed` | A wrong code after a right password | `user`, `at`, `ip`, `userAgent` |

All of them can be [queued](events.md#queued-listeners); a queued listener gets `userId` and the other fields as JSON. Send the
owner a mail on `TwoFactorChallengeFailed` ("someone knew your password"), on `TwoFactorDisabled` and on `RecoveryCodeUsed`.

## Testing

A test that acts as a user with `actingAs()` skips two-factor authentication on purpose. To test the code step, sign in for real and
compute the code the authenticator would show with `twoFactorCode()`:

```ts title="modules/auth/two-factor.test.ts"
import { twoFactorCode } from '@marmeon/auth';

const setup = (await app.withCookie('marmeon_session', cookie).navigating().get('/settings/two-factor')).page()!.props.setup;
await app.withCookie('marmeon_session', cookie).post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret) } });
```

`twoFactorCode(secret, at?)` takes the key `begin()` returned. A code works once, so a second sign-in in the same test needs a code of
the next step: `twoFactorCode(secret, new Date(Date.now() + 30_000))`.

## Operator reset

A user who lost both the phone and the recovery codes has to be let in by an operator, who must be sure it is the owner. There is
no built-in command for it; `TwoFactorStore.removeAll(userId)` removes the authenticator and every recovery code of an account,
for example from a command of your own. `removeAll()` dispatches nothing: the command dispatches `TwoFactorDisabled` with
`via: 'operator'` itself, so that listeners (the mail to the owner, an audit log) hear of it.

## Key rotation

The secret is encrypted with `APP_KEY`. After you rotate the key, list the old one in `APP_PREVIOUS_KEYS` (see
[encryption](encryption.md)); a secret that was encrypted with an earlier key still works, and every accepted code stores it
again with the current key. Recovery codes do not depend on `APP_KEY`.
