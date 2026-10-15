# Passkeys

## Introduction

A passkey is a key pair that lives on the user's device or in their password manager. The private key never leaves it; your server keeps the public key. To
sign in, the device signs a challenge from your server, after the user has proved themselves to the device with a fingerprint, a face or a PIN.
There is no password to phish, reuse or leak.

`@marmeon/auth` brings the checks, the storage and the sign-in steps. A passkey does two jobs:

- **A second factor.** After the password, a passkey of the account counts like the code of an authenticator app (see
  [two-factor authentication](two-factor-authentication.md)).
- **A sign-in on its own.** "Sign in with a passkey" needs no password and no second step: the passkey, unlocked on the device, is both.

Passkeys are optional per user and per app. An app that does not register the provider ([Setting up](#setting-up)) has no passkey
configuration and no routes, and the WebAuthn library behind them is loaded only by code that imports `@marmeon/auth/passkeys`: as long as
none of yours does, nothing loads it. The example app in `apps/web-app` shows the pages: the
login page, the passkey step of the sign-in and a settings page; [the starter kit](#in-the-starter-kit) brings them to a new app.

## Requirements

WebAuthn works on secure origins only: `https://`, or `http://localhost` while you develop. The relying party, the identity a passkey
belongs to, comes from your configuration and never from the request, because a `Host` header is the client's to forge:

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_URL` | required | Its host is the **RP ID**, its origin the one allowed origin. |
| `AUTH_PASSKEY_RP_ID` | host of `APP_URL` | Set it to a parent domain (`example.com`) to let passkeys work on all of its subdomains. |
| `AUTH_PASSKEY_ORIGINS` | origin of `APP_URL` | Comma-separated, exact origins (`https://app.example.com,https://admin.example.com`). |

The RP ID must be the host of every origin or a parent domain of it, on a label boundary: `example.com` suits `app.example.com`, `ample.com`
does not. Every origin must be `https:` or `http://localhost`, and an IP address is refused, since passkeys are bound to names.
Browsers also refuse an RP ID that is a public suffix such as `co.uk`, so a parent domain is meant to be your own registrable domain,
not the suffix under it. For development, set `APP_URL=http://localhost:3000` and open the app as `localhost`: `127.0.0.1` is refused
with a message that names the address to use.

These are checked the first time passkeys are used, not at the start: a wrong `AUTH_PASSKEY_ORIGINS` stops no app that has no passkeys.

## Setting up

Add the table, register the provider and tell the framework that passkeys are factors. The table is yours, like the tables of
[two-factor authentication](two-factor-authentication.md#setting-up):

```ts title="modules/auth/migrations/2026_10_13_130000_create_passkeys_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('passkeys', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('user_handle', 64); // the account's random handle, the same in each of its rows
      table.string('credential_id', 1400).unique();
      table.text('public_key'); // public: not .secret()
      table.integer('algorithm');
      table.bigInteger('sign_count');
      table.json('transports');
      table.string('aaguid', 36);
      table.boolean('backup_eligible');
      table.boolean('backed_up');
      table.string('name', 100);
      table.timestamp('last_used_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('passkeys'),
});
```

```ts title="modules/auth/index.ts"
import { PasskeyServiceProvider } from '@marmeon/auth/passkeys';
import { defineModule } from '@marmeon/core';
import { AuthServiceProvider } from './AuthServiceProvider.ts';

export default defineModule({
  name: 'auth',
  providers: [AuthServiceProvider, PasskeyServiceProvider],
  // …
});
```

```ts title="modules/auth/AuthServiceProvider.ts"
import { combineFactors, TwoFactorState, TwoFactorStore, UserProvider } from '@marmeon/auth';
import { PasskeyStore } from '@marmeon/auth/passkeys';
import type { Container, ServiceProvider } from '@marmeon/core';
import { UserRepository } from './UserRepository.ts';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(UserRepository);
    container.bind(UserProvider, (c) => c.make(UserRepository));
    // Both sources: the authenticator app and the passkeys.
    container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore)));
  }
}
```

`PasskeyServiceProvider` registers `PasskeyStore` and the request-scoped `Passkeys` service, and lets `TwoFactor.challenge()` accept a
passkey. The binding of `TwoFactorState` is what makes a registered passkey a factor: `combineFactors()` joins the authenticator app and
the passkeys into one answer. Without it `registrationOptions()` throws, because a passkey that is never asked for would be no protection.

To switch passkeys off again, remove the provider, `PasskeyStore` from `combineFactors()` and both imports of `@marmeon/auth/passkeys`.

Because a registered passkey is a factor, an account that has one needs a second step after its password too. The first passkey of an
account turns two-factor authentication on for it: it makes the [recovery codes](two-factor-authentication.md#recovery-codes) and signs out
the other devices, as the first authenticator app does.

## Passwordless sign-in

The login page asks for the options, lets the browser sign the challenge, and posts the answer:

```ts title="modules/auth/controllers/PasskeySignInController.ts"
const done = await this.#passkeys.signIn(ctx.body.response, { remember: ctx.body.remember });
if (done.ok) return this.redirect().intended().route('user-profile.me');
```

`signInOptions()` has no list of credentials, so nothing is learnt about which accounts exist; the browser offers the passkeys it holds.
`signIn()` finds the passkey by its credential id, checks the response against the stored key, and requires the response to carry the
account's user handle. The user is the passkey's own account. It returns the user, or an `err`:

| `kind` | Meaning |
| --- | --- |
| `no-challenge`, `expired` | No challenge is open in this session, or it is older than five minutes. |
| `invalid` | Anything else: an unknown passkey, a wrong signature or origin, a missing user verification. The client learns nothing more. |
| `clone-suspected` | The passkey's sign count did not move forward ([below](#counter-and-cloned-keys)). |
| `throttled` | Sixty failed tries a minute from one address. `retryAfter` is in seconds. Only failures count, so many people may sign in from behind one address, and garbage sent from an address cannot lock the owner out. |

The `Login` event says `via: 'passkey'`. A listener that switches over `event.via` exhaustively must handle the new value. The new-sign-in notice of the example app (`apps/web-app`) covers passkeys too: with no password typed, it is the owner's only hint. The session counts as
having passed a second factor and as freshly [confirmed for sudo mode](authentication.md#sudo-mode): the passkey, proven with user verification just now, is what `confirmedPassword()` asks for.

On the login page, show the passkey button after hydration and only where `PublicKeyCredential` exists, so that without JavaScript there is
just the password form. Put `autocomplete="username webauthn"` on the e-mail field and start the request with `mediation: 'conditional'`
to offer the passkeys inside the browser's autofill. The example app keeps this small browser code in `modules/auth/passkeys.ts`: it
uses `PublicKeyCredential.parseRequestOptionsFromJSON()` and `credential.toJSON()` where they exist and a base64url fallback elsewhere.

## As a second factor

After a correct password the account's passkeys appear next to the code. `challengeOptions()` allows only the account's own passkeys,
and `TwoFactor.challenge()` takes the answer:

```ts title="modules/auth/controllers/PasskeyChallengeController.ts"
const done = await this.#twoFactor.challenge({ passkey: ctx.body.response });
```

It returns the same errors as with a code, `invalid-code` for a passkey that did not count. The checks run in the order of the
[sign-in](two-factor-authentication.md#the-sign-in): the waiting sign-in and its account, the throttle, then the passkey. The passkey is
looked up in the store at that moment and must belong to the account that typed the password; one deleted in between is refused. A wrong
passkey counts against the five tries of the waiting sign-in and dispatches `TwoFactorChallengeFailed`.

Passkeys cannot be guessed, so they share the generous counter of the recovery codes, ten a minute, not the budget of the code attempts.

## As a step-up

An account that has only passkeys must also get through a page behind [`twoFactor()`](two-factor-authentication.md#requiring-it). On the
`verify` page the signed-in user proves a passkey again: `stepUpOptions()` opens a challenge bound to the signed-in account and allows
only its passkeys that are not suspended, and `TwoFactor.stepUp()` takes the answer:

```ts title="modules/auth/controllers/PasskeyStepUpController.ts"
const done = await this.#twoFactor.stepUp({ passkey: ctx.body.response });
if (done.ok) return this.redirect().intended().route('auth.sensitive');
```

The challenge has its own purpose, `step-up`: one issued for a waiting sign-in does not serve a step-up, and the reverse. It leaves the
session before anything is checked and is used up atomically, so a response works once. The passkey is looked up at that moment, must
belong to the signed-in account and must not be suspended; user verification is required, and the sign count follows the rule above. Every
failed check is `invalid-code`, whatever the reason, so the client learns nothing. `TwoFactorChallengeFailed` with `during: 'step-up'` fires only for a
wrong answer (a bad signature, an unknown, foreign or suspended passkey), not for a challenge that is missing, used or expired. A wrong response does not end the session.
`throttled` and `no-challenge` are the only other answers: the latter means the account has no factor at all. A success marks the session as proven under a new session id, as with a code.

The check is throttled per account by the generous counter of the recovery codes, before the response is looked at. `stepUpOptions()`
only opens a challenge and has no throttle of its own: give its route a limit, as the example app does (ten a minute per user).

## Confirming sudo mode

A user with a passkey confirms [sudo mode](authentication.md#sudo-mode) with it instead of typing the password. `confirmOptions()` opens a
challenge bound to the signed-in account and to this purpose, and allows only the account's passkeys that are not suspended;
`confirm()` takes the answer:

```ts title="modules/auth/controllers/PasskeyConfirmController.ts"
const done = await this.#passkeys.confirm(ctx.body.response);
if (done.ok) return this.redirect().intended().route('auth.security');
if (done.error.kind === 'throttled') return this.json({ error: this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfter }) }, 429);
return this.json({ error: this.#translator.get('auth.passkeys.failed') }, 422);
```

The challenge has its own purpose, `confirm`: one issued for a sign-in or a step-up does not serve here, and the reverse. It leaves the
session before the response is looked at, so a response works once. The passkey must belong to the signed-in account and not be suspended, and
user verification is required. On success the session gets a new id, `confirmedPassword()` lets it through for `AUTH_PASSWORD_TIMEOUT`
seconds, and it counts as having proven a second factor. `confirm()` returns `err` for a response that fails, with the kinds of
[a sign-in](#passwordless-sign-in) and `throttled` (ten a minute for the account, a success clears the count); a wrong answer fires `TwoFactorChallengeFailed` with `during: 'confirm'`, a challenge that is
missing, used or expired does not. `confirmOptions()` answers `no-challenge` when the account has no usable passkey; it only opens a challenge and has no throttle of its own: give its route a limit.

A passkey that can confirm sudo mode alone must not open every door. Actions that would let a holder of the session stay in the account
ask for the password in the same form, and `remove()` does so for every passkey, as `register()` does; so do `TwoFactor.regenerateRecoveryCodes(password)`, the e-mail change and a new API token in the starter kit. An empty password counts as none and uses up no try.

## Managing passkeys

`Passkeys` offers what a settings page needs:

| Method | Does |
| --- | --- |
| `list()` | The signed-in user's passkeys: `id`, `name`, `createdAt`, `lastUsedAt`, `suspended`, `synced`. |
| `registrationOptions()` | The options for `navigator.credentials.create()`. Needs a recent confirmation (a password or a passkey, `confirmedPassword()`) within 15 minutes by default. |
| `register(response, name, password)` | Adds the passkey. Resolves with `recoveryCodes` (the first factor) or `null`. |
| `rename(id, name)` | Renames; `false` for an empty or too long name or one that is not the user's. |
| `confirmOptions()`, `confirm(response)` | Confirm [sudo mode](#confirming-sudo-mode) with a passkey. |
| `remove(id, password?)` | Removes. Every passkey needs `password`; the recovery codes go with the last factor. |
| `release(id, password)` | Lets a suspended passkey sign in again, with the password typed now. |

On an account that already has a factor, `registrationOptions()`, `register()`, `remove()` and `release()` also throw unless this
session proved a second factor within 15 minutes by default ([how long](authentication.md#how-long-a-sign-in-lasts)), because the password alone must not let a stolen session add a passkey or take one
away; put those routes behind `confirmedSecondFactor()` (see [Changing the factors](two-factor-authentication.md#changing-the-factors)).
`rename()` and `list()` stay free of it.

`register()` checks the session against the account in the transaction that stores the passkey: when the session ended meanwhile (another
device changed the password, `AccountSessions.end()` ran), nothing is stored and it returns `{ kind: 'signed-out' }`; send the user to the sign-in.

Both the registration and the list are behind `confirmedPassword()` ("sudo mode"), and **`register()` asks for the password again in the
same form for every passkey, not only the first**. A passkey outlives a password change and a password reset, and it works without the password.
Someone who held a stolen session inside the sudo window could otherwise add one and keep a way in that survives the owner's recovery.
Typing the password costs the owner a second; the check is counted per sign-in (five a minute and twenty an hour) and, for a sign-in that did not begin with a typed
password, per account (twenty an hour), in the same limiter as `remove()`, so it is no oracle for guessing the password and a passkey-only session cannot lock out the owner who signed in with it ([how](authentication.md#sudo-mode)). The example app's `throttlePasswordChecks()` helper is for the password forms
of your own; `Passkeys` throttles its checks itself.

The first passkey also signs out every other device (sessions and remember-me tokens, a second time after the insert), shows the
recovery codes once in the answer of the registration, and dispatches `TwoFactorEnabled` with `factor: 'passkey'`. A later passkey makes no
new codes. `remove()` of the last factor takes the recovery codes in the same transaction, and the store decides inside it, so two
removals at once cannot both pass without the password.

An account holds at most 20 passkeys; the 21st answers `limit`. Names lose control and invisible format characters (a bidi override would otherwise
reorder the text of the list). Registration accepts ES256 and EdDSA keys, and RSA keys only with the exponent 65537 and at most 4096 bits.

An account without a password cannot register its first factor: turning it on signs out the other devices with the password hash, so
`register()` throws for it.

## Counter and cloned keys

An authenticator counts its uses. A sign-in whose count is not above the stored one, while either is above zero, may come from a copied key
and is refused with `clone-suspected`: the stored count stays as it was, the passkey is **suspended**, a `PasskeyCloneSuspected` event is dispatched
and a warning is logged. A suspended passkey signs nobody in, neither on its own nor as a second factor, and the list shows it as suspended.
Only its owner can lift that: `release()` and `remove()` of a suspended passkey need the password typed now, so someone who holds a stolen
session cannot tidy the evidence away. Synchronised passkeys report 0 every time, which is allowed. The new count is written with a conditional `UPDATE`, so two
sign-ins with one count cannot both succeed. The challenge makes a replay of a response impossible in the first place.

The rule also suspends the legitimate device when a real signature carries a count that went backwards, for example when two ceremonies of one
authenticator finish in the other order, or when an authenticator counts wrongly. That is intended: the server cannot tell a copy from a faulty
counter, so it fails closed. If it is the account's only factor, the owner signs in with a recovery code and lifts the suspension with `release()`.

## What it protects against, and what not

A passkey is bound to your origin by the browser, so a copy of your login page cannot use it. Every challenge works once and only for its
purpose, user verification is required (the device checks the user), your origin and RP ID are fixed in configuration, and a passkey
signs in only its own account. The attestation is not trusted: it is reduced to `none` before anything looks at it, so its statement is never parsed and no certificate
or revocation list is fetched for bytes the client chose. Only the key is kept, and no authenticator models are filtered. A challenge is also
spent across processes at once, so parallel requests with one cookie cannot replay a response of a synchronised passkey.

User verification is required everywhere. A security key without a PIN or a biometric therefore does not work, and neither does an
authenticator that cannot verify the user. That keeps the passwordless sign-in a real second factor and the rule easy to check.

It does not protect against someone who controls the user's unlocked device or the account's recovery path, or against a server whose code or
`APP_URL` an attacker changes. A user who lost every passkey and the recovery codes needs the operator's reset (`PasskeyStore.removeAll(userId)`
plus `TwoFactorStore.removeAll(userId)`, and the events dispatched by the command).

## In the starter kit

`make:auth` writes the passkeys into a new app (the [starter kit](starter-kit.md#passkeys)): the migration of the `passkeys` table
(`foreignId('user_id').constrained().cascadeOnDelete()`, with `suspended_at`), the binding
`combineFactors(TwoFactorStore, PasskeyStore)` and `PasskeyServiceProvider` in the module, the controllers and routes, the limits of the
options requests (`passkey-options`, 30 a minute for each client; `passkey-challenge-options`, 10), the mails and the pages, in both languages:

| Page | What it does |
| --- | --- |
| `auth/Login` | A button "Sign in with a passkey" after the page has loaded, and the browser's autofill in the e-mail field (`autocomplete="username webauthn"`). The password form works without JavaScript. |
| `auth/TwoFactorChallenge` | A button for a passkey when the account has one, the code form when it has an authenticator app, the recovery code always. |
| `auth/Passkeys` | In the settings: the list with the dates, rename, release of a suspended passkey, removal, and the form that adds one with a name and the password. The first passkey shows the recovery codes once. |

`modules/auth/passkeys.ts` is the browser side, written as app code you can change: it uses the browser's own conversion of the
options and responses where it has one (`parseCreationOptionsFromJSON`, `toJSON()`) and a short fallback otherwise. The conditional sign-in
in the e-mail field ends with an `AbortController` when the button is pressed or the page closes, and does not start again after a
sign-in. The pages send no inline script and no `style`, so a strict content security policy accepts them.

An account with a passkey has a second factor, so `twoFactor()` applies to it. The kit's `/settings/two-factor/verify` page, where
`twoFactor()` sends a session, offers a passkey, the code of an authenticator app and a recovery code, as the sign-in does (its options
request has its own limit, `passkey-step-up-options`, 10 a minute for each user). On `/settings/two-factor` an account with passkeys only
shows "Protected by passkeys", the recovery codes left and "Make new recovery codes".

The kit's listeners mail the owner on `PasskeyRegistered`, `PasskeyRemoved`, `PasskeyCloneSuspected` and `PasskeySignInFailed` (the
last at most once an hour for each account). Passkeys outlive a password reset, so `NotifyAboutPasskeysAfterReset` also listens to
`PasswordReset` and mails the passkeys the account still has; it is no queued listener, because that event is not queueable, and it logs
rather than throws if the mail cannot be queued, so a reset that happened is never undone. The operator's `marmeon auth:reset-two-factor`
removes the passkeys together with the authenticator and the recovery codes.

## Events

| Event | When | Fields |
| --- | --- | --- |
| `PasskeyRegistered` | `register()` added a passkey | `user`, `name` |
| `PasskeyRemoved` | `remove()` removed one | `user` |
| `PasskeyCloneSuspected` | A sign-in was refused for its sign count, and the passkey suspended | `user`, `passkeyId` |
| `PasskeySignInFailed` | A passwordless sign-in failed against a passkey that exists: a wrong signature or user handle. Nothing for an unknown passkey | `user`, `ip`, `userAgent` |
| `Login` | A passwordless sign-in | `via: 'passkey'` |
| `TwoFactorChallengeFailed` | A wrong passkey after the password, at a step-up, or when confirming sudo mode | `user`, `at`, `ip`, `userAgent`, `during` (`sign-in`, `step-up` or `confirm`) |

The first passkey also dispatches `TwoFactorEnabled` and `RecoveryCodesGenerated`, and removing the last factor `TwoFactorDisabled`. All of
them can be [queued](events.md#queued-listeners). Send the owner a mail on `PasskeyRegistered`, `PasskeyRemoved`,
`PasskeyCloneSuspected` and `PasskeySignInFailed`.

Anyone who knows a credential id can cause up to 60 `PasskeySignInFailed` events a minute per address, so a listener that turns them into mails
limits them per account. Count with the [rate limiter](rate-limiting.md#counting-by-hand), as the example app does for its other notices:

```ts title="modules/auth/listeners/MailAboutFailedPasskeySignIn.ts"
import { RateLimiter } from '@marmeon/cache';
import type { PasskeySignInFailed } from '@marmeon/auth';

export class MailAboutFailedPasskeySignIn {
  constructor(private readonly limiter: RateLimiter) {}

  async handle(event: PasskeySignInFailed): Promise<void> {
    // At most one mail an hour and account, however many attempts there were.
    if (!(await this.limiter.attempt(`passkey-failed-mail:${event.userId}`, 1, 3600))) return;
    // … queue the mail to event.user
  }
}
```

## Testing

`softAuthenticator()` is an authenticator in software: it registers credentials and signs in with them, and produces the WebAuthn JSON a
browser would send, with ES256, EdDSA or RS256 keys. Give it your relying party, hand it the options the server returned, and post the result back:

```ts title="modules/auth/passkeys.test.ts"
import { softAuthenticator, type SoftOptions } from '@marmeon/auth';
import { createTestApp } from '@marmeon/testing';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

const app = await createTestApp(application, { database: 'refresh' });
const ada = await app.factory(UserFactory).create();
// The relying party is the APP_URL of the test environment.
const authenticator = softAuthenticator({ origin: 'http://localhost', rpId: 'localhost' });

const login = await app.post('/login', { form: { email: ada.email, password: 'password' } });
const cookie = login.cookie('marmeon_session')!;
const options = await app.withCookie('marmeon_session', cookie).post('/settings/passkeys/options', { json: {} });
await app.withCookie('marmeon_session', cookie).post('/settings/passkeys', {
  json: { response: authenticator.register(options.json<SoftOptions>()), name: 'Laptop', password: 'password' },
});
```

`authenticate(options)` signs in. A second argument bends one response to test the refusals: `origin`, `rpId`, `challenge`,
`userVerified: false`, `userPresent: false`, `crossOrigin: true`, `signCount`, `backupEligible`, `badSignature` and, for a registration, `attestation: 'packed'`. `synced: true` in the
configuration reports a count of 0 every time, as synchronised passkeys do. A test that acts as a user with `actingAs()` skips the second
factor, as for [two-factor authentication](two-factor-authentication.md#testing).
