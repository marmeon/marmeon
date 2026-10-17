# Starter Kit

## Introduction

The starter kit is what `pnpm create marmeon` gives you by default: a blank app plus two modules. The `auth` module handles
accounts: sign-in, registration, password reset, the confirmation of an address, a security page, two-factor authentication, passkeys and API tokens. The `home`
module is the page at `/`. Both are ordinary modules in your app, written as source code, so you read them, change them and
delete what you do not need. [Your First App](first-app.md) adds a notes module of your own on top of the kit.

```sh
pnpm create marmeon my-app          # the starter kit
pnpm create marmeon my-app --minimal  # a blank app, without both modules
```

The auth module comes from the generator `marmeon make:auth`. It writes the module once, and from then on it belongs to your app.
The mechanics behind it, such as hashing, sessions, tokens and policies, stay in the `@marmeon/auth` package, and updates of the
framework bring them.

## What the auth module holds

| Part | What it is |
| --- | --- |
| `index.ts` | The module's definition: its provider, the listeners that send the confirmation mail and the notes about the second factor and about passkeys, the queued jobs, the migrations, the seeder, the routes, the schedule and the commands `auth:end-sessions`, `auth:prune-unverified` and `auth:reset-two-factor`. |
| `AuthServiceProvider.ts` | Finds users through the `UserRepository`, binds the authenticator app and passkeys as the sources of second factors, shares `auth` with every page, and sets the rate limits of its forms. |
| `users.ts`, `UserRepository.ts` | The `User` type and the only code that reads a password hash or a session key. The `session_key` column lets `auth.updateSessionKey()` end an account's other sessions with every session driver. |
| `routes.ts`, `api-routes.ts` | The pages and forms, and `GET /api/user` for API tokens. |
| `controllers/` | 46 controllers, one per endpoint. A form's controller validates it with a request schema. |
| `views/`, `layouts/` | The React pages and the app's layout, `AppLayout`, with a settings layout inside it. |
| `mail/` | Ten mails: the confirmation of an address, the reset link, the notes about a change of address and about a known address, the notes about the second factor and about passkeys, the note about a copied "keep me signed in" cookie, and the note that an account stopped taking passwords. |
| `jobs/`, `listeners/`, `tasks/` | The work that runs on the queue or on a schedule. |
| `middleware/` | `ShareAuthProps` and `ConfirmedAddress`. |
| `migrations/` | The tables `users`, `marmeon_remember_tokens`, `marmeon_password_reset_tokens`, `marmeon_personal_access_tokens`, `marmeon_two_factor_authentications` with `marmeon_two_factor_recovery_codes`, `marmeon_passkeys` and `marmeon_sign_ins`. An app generated before the remember-me table had its `account_fingerprint` column adds it with the migration shown under [remember me](authentication.md#remember-me). |
| `factories/`, `seeders/` | `UserFactory` for tests, and `UserSeeder` with `test@example.com` and the password `password`. The seeder runs only with `marmeon db:seed` or `migrate:fresh --seed`: never seed a server with it. |
| `schedule.ts` | The nightly clean-up of expired tokens and changes of address. |
| `auth.test.ts` and twelve more | The module's own tests. |

The module's routes each say who may call them, as the app's do. Its groups decide with `everyone`: the sign-in and registration
pages are open to guests, and every action behind `authenticate()` concerns only the signed-in user's own account. A route you
add to the module needs a decision of its own. The [authorization](authorization.md#every-route-decides) page has the rule.

To add a language, put a file next to every `en.ts` of the app — a locale with any language file is supported (see [Localization](localization.md), `APP_LOCALES`).

`apps/web-app` in the framework's repository shows such a module grown further, with a welcome mail.

## The pages

| Path | Name | Who |
| --- | --- | --- |
| `/login` | `auth.login` | guests |
| `/register` | `auth.register` | guests |
| `/register/sent` | `auth.register.sent` | guests, after they register |
| `/two-factor-challenge` | `auth.two-factor.challenge` | guests whose password was right and who have a second factor |
| `/forgot-password`, `/reset-password` | `auth.password.request`, `auth.password.reset` | guests |
| `/dashboard` | `dashboard` | signed in, with a confirmed address |
| `/confirm-password` | `auth.password.confirm` | signed in, with a confirmed address; asks for the password, and offers "Use a passkey instead" to an account with a usable passkey |
| `/confirm-password/passkey/options`, `/confirm-password/passkey` | `auth.password.confirm.passkey.options`, `auth.password.confirm.passkey` | the same; `POST`, the options limited to ten a minute per user |
| `/settings/security` | `auth.security` | the same, and a recent confirmation (password or passkey) within 15 minutes by default |
| `/settings/sign-ins/:signIn/end` | `auth.sign-ins.destroy` | the same as the security page; `POST`, ends one other sign-in |
| `/settings/two-factor` | `auth.two-factor` | the same |
| `/settings/two-factor/verify` | `auth.two-factor.verify` | signed in, with a confirmed address; for `twoFactor()` |
| `/settings/passkeys` | `auth.passkeys` | the same as the security page |
| `/settings/tokens` | `auth.tokens` | the same |
| `/email/verify` | `auth.verification.notice` | signed in |

A signed-in user who opens a guest page goes to `/dashboard`. The security page changes the password and the e-mail address,
signs out the other devices, and lists the browsers the account is signed in on, each with a button to end it ([sign-ins](authentication.md#sign-ins)). The two-factor page sets up an authenticator app and shows the recovery codes once; the
challenge page asks for the code, a passkey or a recovery code after the password. The passkeys page adds, renames and removes passkeys, and the login page offers "Sign in with a passkey". The tokens page creates and revokes API tokens. A passkey alone can confirm sudo mode, so the forms that change the e-mail address, create an API token, turn on an authenticator app and make new recovery codes ask for the current password too, as the passkeys and password forms do ([sudo mode](authentication.md#sudo-mode)). `/` belongs to the home module, so the auth
module leaves it free.

The routes are an ordinary route file, so you change a path, add a page or remove one in `modules/auth/routes.ts`. The
[routing](routing.md#route-files) page explains route files.

## The look

A new starter kit app has two stylesheets, both yours to change. They are plain CSS, no preprocessor and no `style` attributes
(see [No `style` attributes](styling.md#no-style-attributes)).

| File | Holds |
| --- | --- |
| `styles/app.css` | The tokens, the base styles for plain HTML, the layout classes, the font. |
| `modules/auth/auth.css` | The auth module's classes: header, toasts, guest cards, settings navigation, the dashboard cards and `.placeholder`, `.hint`, the width of the settings forms, the token table and `.secret`, the box that shows a new token. |

`bootstrap/client.tsx` imports `styles/app.css` right after the framework's stylesheet, and `make:auth` adds `auth.css` after it.
The module's rules use the tokens with a fallback, so `auth.css` also works in an app that has a stylesheet of its own.

The tokens are custom properties on `:root`:

| Token | Use |
| --- | --- |
| `--color-page`, `--color-surface`, `--color-sunken` | The page, the cards on it, and quiet fills such as a hovered button. |
| `--color-field`, `--color-control` | The background and the border of form fields. |
| `--color-text`, `--color-muted`, `--color-line` | Text, quieter text, borders. |
| `--color-accent`, `--color-accent-text`, `--color-focus` | Buttons and links, the text on a button, the focus ring. |
| `--color-accent-hover`, `--color-accent-surface` | A hovered button, and the tint behind the current page in a menu. |
| `--color-danger`, `--color-success` (and `-surface`) | Errors, confirmations. |
| `--font-text`, `--font-mono` | The two font stacks. |
| `--text-sm` to `--text-display`, `--control-height`, `--card-padding` | The type scale, the height of fields and buttons, the padding of cards. |
| `--space-1` to `--space-7`, `--radius-1`, `--radius-2`, `--shadow-2` | Spacing, corners, the shadow of raised things. |

To change the colors, change the values of the tokens, and every page follows. The dark colors sit in the
`@media (prefers-color-scheme: dark)` block of the same file, so edit both. The same file sets the framework's own variables
(`--marmeon-progress-color` and the failure notice) from the tokens.

The classes the pages use are small and yours to reuse:

| Class | For |
| --- | --- |
| `.button`, `.button-secondary` | A button, filled or quiet, on a `<button>` or a `<Link>`. Add `data-destructive` to an action that cannot be undone, and `data-size="small"` for a smaller one beside content, such as the actions of a card or a row. |
| `.field` | A label, a form control and its error, stacked. |
| `.choice` | A checkbox or radio with its label, in a row. |
| `.card` | A box with a border. `data-kind="success"` colors it green. |
| `.badge` | A small pill that marks something, such as "Pinned", next to a heading. |
| `.notice` | A short message, with `data-kind="success"` or `"error"`. |
| `.stack`, `.stack-loose`, `.cluster` | Vertical and horizontal spacing between children. |
| `.hint`, `.muted` | Quieter text. |
| `.placeholder` | The dashed box on the dashboard, where your app's own content goes. |

There is deliberately no rule for the bare `button` element: the framework's own buttons, such as the ones in dialogs, keep
their look.

The text font is IBM Plex Sans, served from your own app: `styles/app.css` imports it from `@fontsource-variable/ibm-plex-sans`,
which Vite bundles into `/assets/`, so no request goes to another host and `font-src 'self'` is enough. To use another font,
replace the `@import` and `--font-text`, and remove the dependency. The mono font is the system's.

## Two-factor authentication

Each user decides for their own account. On `/settings/two-factor` they scan a QR code with an authenticator app, type the first
code and their password, and get ten recovery codes in a layer, shown once. Turning it on signs out their other devices and lists
their API tokens, which keep working. From then on a sign-in with the right password waits on `/two-factor-challenge` for a code
or a recovery code. The settings page and new recovery codes sit behind sudo mode, which asks for a confirmation (the password or a passkey) again after 15 minutes by default ([how long](authentication.md#how-long-a-sign-in-lasts)); turning it off always asks for it.

The owner gets a mail when the factor is turned on or off, when a recovery code signed in (with the number left), and when a
wrong code followed the right password ("someone knows your password", at most once an hour for each account). They are queued
listeners in `listeners/`, and `mail/TwoFactorMail.ts` writes them in the account's language.

A user who lost the phone and the recovery codes is let in by an operator, once sure it is the owner:

```sh
marmeon auth:reset-two-factor ada@example.com --force
```

The command also ends every session and remember-me cookie of the account, so a finder of the lost device cannot enrol a new factor
from a session that is still open; the owner signs in again with the password.

The kit does not require it anywhere: the `twoFactor()` middleware is provided and not installed. It comes with the page it
needs, `/settings/two-factor/verify`; [Two-Factor Authentication](two-factor-authentication.md#in-the-starter-kit) shows the line
that turns it on. To switch the feature off for every account, remove the `TwoFactorState` binding in `AuthServiceProvider.ts`, and the routes,
pages and listeners that use it.

## Passkeys

The login page has a button "Sign in with a passkey" (and the browser's autofill in the e-mail field offers them too), but only after the
page has loaded and only in a browser that has passkeys: without JavaScript there is the password form alone. A passkey signs in without a
password and without a second step. On `/settings/passkeys` a user adds a passkey with a name and **their password, for every passkey**
(a passkey outlives a password change, so a stolen session must not be able to add one), renames it, and removes it, which asks for the password for every passkey and, since that password was just typed, signs out the other devices. The first passkey
turns on two-factor authentication: it signs out the other devices and shows ten recovery codes once, and from then on a sign-in with the
password asks for a passkey, a code or a recovery code on `/two-factor-challenge`. Removing the last factor takes
the recovery codes with it. A passkey whose counter went backwards, which suggests a copy, is suspended and shown with a form to release it.

The owner gets a mail when a passkey is added, removed or suspended, and when a failed passkey sign-in tried one of theirs (at most once an
hour for each account). Passkeys survive a password reset, so a reset also mails the list of passkeys the account still has: whoever
reset the password, the owner sees what still signs in without it. `mail/PasskeyMail.ts` writes them in the account's language.

The owner also gets a mail when an old or forged "keep me signed in" cookie was sent (`RememberTokenReused`): every session and cookie of the
account was ended, and the mail names the time, the address and a parsed browser and system. It says plainly that it is usually someone who holds a copy, and that a browser of the owner can also send an old cookie when a page did not finish loading as it was renewed. `mail/SignInMail.ts` writes it in the account's language.

Passkeys need the relying party from `APP_URL`: open the app as exactly that address, `http://localhost:3000` while developing (not
`127.0.0.1`). [Passkeys](passkeys.md#in-the-starter-kit) explains the rest. The kit's `marmeon auth:reset-two-factor` removes passkeys with
the authenticator and the recovery codes. To switch passkeys off, remove `PasskeyServiceProvider` from `index.ts`, `PasskeyStore` from the
binding in `AuthServiceProvider.ts`, and the routes, pages, listeners and imports of `@marmeon/auth/passkeys` that use them.

## Private registration

The registration never tells anyone whether an address already has an account. A new address and a known one get the same
answer in the same time: a redirect to `/register/sent`, which asks the person to check their inbox. The owner of a known address
gets a mail instead of the confirmation link: someone tried to sign up with it, and here is how to sign in or reset the password.
This keeps a stranger from testing a list of addresses against your users. The mail to a known address goes out at most once an
hour (the job counts attempts per hashed address in the rate limiter's cache), so sign-ups with a stranger's address cannot flood
its owner's inbox; the person who signed up sees the same answer whether the mail was sent or not.

Three more rules follow from it:

- **Nobody is signed in by registering.** The new account signs in like any other. On the pages of the auth module it sees only
  a notice until its owner clicks the link in the mail while signed in. Whoever registers with somebody else's address cannot
  confirm it, and the real owner takes the account over with a password reset.
- **A form field never asks the database.** The live check of the form only looks at the address's format.
- **A change of address waits for its link.** A new address on the security page is kept aside until the link sent to it is
  clicked, and the answer is the same for a free and a taken address. The owner of a taken address gets a note instead, and
  nothing changes. A pending change expires after 60 minutes.

The price is that someone who forgot they have an account learns it only from their inbox, and nobody can start before the
mailer and a queue worker run.

### Your own pages

The notice guards the pages of the auth module alone: its routes pass its `ConfirmedAddress` middleware. A route of another
module behind `authenticate()` alone lets in every signed-in account, also one whose address is not confirmed, such as one
registered with somebody else's address. Add `verified()` of `@marmeon/auth` after `authenticate()`:

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(verified()).authorize(everyone).get('/notes', ListNotesController).name('notes.index');
});
```

`verified()` sends an account without a confirmed address to the notice, `/email/verify`, and answers `403` to a request that
expects JSON. It asks for a confirmed address whatever `AUTH_PRIVATE_REGISTRATION` says.

> [!WARNING]
> Without `verified()`, an account registered with somebody else's address reads and writes on your pages before anyone confirmed
> it. While the registration is private, put it on every route of your own that signed-in users reach.

### Turning it off

Set `AUTH_PRIVATE_REGISTRATION=false` when the accounts of your app are public anyway:

```sh title=".env"
AUTH_PRIVATE_REGISTRATION=false
```

Then a taken address is a field error when the form is sent, and a new account is signed in at once. The confirmation mail still
goes out, but the app's pages no longer wait for it. A new address on the security page takes effect at once. `/register/sent`
and the change-of-address link answer 404.

> [!WARNING]
> With private registration off, the rate limit of the form is all that stops a stranger from finding out who has an account.
> Outside development and tests the app logs a warning about it at every start.

Only `true` and `false` are allowed. Any other value stops the start; an empty one counts as unset. To demand a confirmed address with private registration
off, put `verified()` of `@marmeon/auth` in place of `ConfirmedAddress` in `routes.ts`. The routes that add an authenticator app or a passkey
demand a confirmed address in either mode, as does creating an API token, and the settings pages say so with a link to send the mail
again. The owner's password reset removes whatever an account with an unconfirmed address holds (factors and tokens). Set
`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` as well for the other accounts, as the
[API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains.

## Guesses against one account

Besides the limits per client, `LoginController` stops password sign-ins to one account after 100 a day, whichever clients they come from:
a guess spread over many addresses still ends. The count is kept per address, normalised, under a hash of it, and is taken before the password
is checked; a failed or a right password both count until a sign-in succeeds, and a successful sign-in and a completed password reset clear it.
Past 100, nothing is checked, not even the right password, and the form says: "Too many failed sign-ins for this account. Reset your password
or sign in with a passkey." Passkey sign-in and the password reset stay open (a passkey sign-in clears the count too), so the owner has two ways in. The answer is the same for an
address that has no account (its failures are counted too), and so is the work: the request queues `SendLockoutMailJob`, once per day and
address, and the job mails the owner only when an account exists. The `Lockout` event is dispatched at that moment too. The number is
`ACCOUNT_SIGN_INS` in `account-failures.ts`.

The cost is one cache entry per address tried, kept for a day, for addresses with and without an account (the entry has the full hash of the
address, so it cannot be cut down). A public deployment should keep the counts in the `database` or `redis` cache store, not in
`file`, and keep `cache:prune` scheduled (see [cache](cache.md)), so a flood of made-up addresses does not pile up.

Anyone can lock out an address they know by sending 100 wrong passwords. That is the price of the limit: the owner resets the password or uses a
passkey, and the mail says so.

## Signing an account out everywhere

After a lost device or a suspected theft, an operator ends every session and every "keep me signed in" cookie of an account:

```sh
marmeon auth:end-sessions ada@example.com --force
```

The command asks `AccountSessions` of `@marmeon/auth` (see [Authentication](authentication.md#ending-every-session-of-a-user)) and
prints how many stored sessions it deleted at once; the others end at their next request. The password still signs in, so change
it first when it may be known. `--force` is required in every environment, an unknown address fails with exit code 1, and an error
of the call is shown, not hidden.

After a leak, `marmeon auth:end-all-sessions --force` ends the sessions of every account at once. The module's `UserRepository` has
the `updateEverySessionKey()` it needs; see [ending every session of every account](authentication.md#ending-every-session-of-every-account).

## Mail, the queue and the scheduler

Every mail of the module goes through the queue, on its `mail` queue. A new app has the queue's table and `marmeon dev` starts a
worker, so this works from the first start. By default the mailer writes each mail to the log. On a server you need a real
mailer, `MAIL_MAILER=smtp`, and a worker, `marmeon queue:work`. The [deployment](deployment.md) page shows both.

The scheduler deletes expired reset links, remember-me tokens and API tokens every night at 03:10, and the changes of address
that nobody confirmed in time. `marmeon dev` runs the scheduler for you. On a server, run `marmeon schedule:work`.

### Accounts nobody confirmed

`marmeon auth:prune-unverified` deletes the accounts whose address was never confirmed, once `AUTH_UNVERIFIED_DAYS` days have
passed since they signed up. It ends a registration with somebody else's address, and it keeps no data of sign-ups nobody
finished. An account that was confirmed once is never deleted.

The command is not scheduled by itself, because deleting accounts is your app's decision. Turn its line on in
`modules/auth/schedule.ts`:

```ts title="modules/auth/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';
import { PruneEmailChanges } from './tasks/PruneEmailChanges.ts';

export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
  s.call(PruneEmailChanges).daily().at('03:10').onOneServer().name('auth.prune-email-changes');
  s.command('auth:prune-unverified').daily().at('03:20').onOneServer();
});
```

`onOneServer()` runs a task on one server only, as long as the servers share a cache: `CACHE_DRIVER=database` or `redis`.

> [!WARNING]
> Deleting an account cannot be undone. With private registration off, such accounts were signed in and may have used the app.
> Leave the line off where unconfirmed accounts belong to your model, such as invited team members or imported users.

## IDs

The kit's tables use integer ids, which keep indexes and foreign keys small. UUIDs are an option, and the choice is yours. Two
patterns work, and [UUID keys](migrations.md#uuid-keys) weighs them:

- **A public key next to the integer id.** Add `table.uuid('public_id').unique().useUuidv7();` to the `users` migration of
  `modules/auth/migrations/`, and set `static routeKey = 'public_id';` in `UserRepository`. Relations keep joining on `id`, and
  the routes you bind to `UserRepository`, such as a profile at `/users/:user`, then take the UUID. A route that takes the integer id answers 404. SQLite adds
  such a column only when the table is created, so make the change before the first migration or run `migrate:fresh`.
- **A UUID as the primary key.** Replace `table.id()` with `table.uuidId()` in the `users` migration, before the first
  migration, and make the tables that reference users use `foreignUuid()`: `marmeon_remember_tokens` and `marmeon_personal_access_tokens` use
  `foreignId('user_id')`. Code that types a user id as a `number`, such as `UserRepository.findById(id: number)`, has to follow.
  Sessions, notifications and `AuthUserId` already allow a string.

`apps/web-app` in the framework's repository shows both: `users` has a `public_id`, and `profile_links` has a UUID as its
primary key.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_PRIVATE_REGISTRATION` | `true` | `false` makes the registration and the change of address say "taken", and signs a new account in at once. |
| `AUTH_UNVERIFIED_DAYS` | `7` | Days an account may stay without a confirmed address before `auth:prune-unverified` deletes it. `0`: the command deletes none. |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | `false` | `true`: a new password and a password reset revoke every API token of the user. A reset of an account with an unconfirmed address revokes them whatever this says. |

The [authentication](authentication.md#configuration) page lists the other `AUTH_*` variables, and [how long a sign-in lasts](authentication.md#how-long-a-sign-in-lasts) every lifetime. The login page shows its checkbox only while `AUTH_REMEMBER_DAYS` is above `0`.

## Adding the module to an existing app

An app made with `--minimal` gets the module later from the generator:

```sh
pnpm marmeon make:auth
```

The command copies the module to `modules/auth/`, adds it to `modules` in `bootstrap/app.ts` and imports its stylesheet,
`modules/auth/auth.css`, in `bootstrap/client.tsx`. It names every package the module needs that your `package.json` lacks, and
any that is only a dev dependency: the module runs in production, so those belong in `dependencies`. When nothing is missing, it
writes the route types. It needs `config/app.ts` with `AppConfig`, which every new app has.

After it, run `pnpm marmeon migrate`, and set the `MAIL_*` variables before anyone else uses the app. An existing
`modules/auth/` stays as it is unless you pass `--force`, which overwrites it with the templates. `--adapter=react` names the UI
adapter, and React is the only one with templates.

## Testing

The module brings its own tests: sign-in, registration with both values of `AUTH_PRIVATE_REGISTRATION`, the change of address
and the deletion of unconfirmed accounts. They run with the app's other tests:

```sh
pnpm test
```

`UserFactory` makes users in your own tests, with the password `password`, and `#modules/auth` exports it. The
[HTTP tests](http-tests.md#sessions-and-signing-in) page shows how to act as a signed-in user.
