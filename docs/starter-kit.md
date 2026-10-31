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

Either way, the app also has an `AGENTS.md` and a `CLAUDE.md` ([coding agents](agents.md)).

The auth module comes from the generator `marmeon make:auth`. It writes the module once, and from then on it belongs to your app.
The mechanics behind it, such as hashing, sessions, tokens and policies, stay in the `@marmeon/auth` package, and updates of the
framework bring them.

## What the auth module holds

| Part | What it is |
| --- | --- |
| `index.ts` | The module's definition: its provider, the listeners that send the confirmation mail and the notes about the second factor and about passkeys, the queued jobs, the migrations, the seeder, the routes, the schedule and the command `auth:prune-unverified` (`auth:end-sessions` and `auth:reset-two-factor` come with `@marmeon/auth`). |
| `AuthServiceProvider.ts` | Finds users through the `UserRepository`, binds the authenticator app and passkeys as the sources of second factors, and shares `auth` with every page. The rate limits of its forms are those of `@marmeon/auth` ([the limits of the auth routes](authentication.md#the-limits-of-the-auth-routes)). |
| `users.ts`, `UserRepository.ts` | The `User` type and the only code that reads a password hash or a session key. It is the app's `UserProvider`: the statements that write a hash or a session key are `credentialWriter()` of `@marmeon/auth`, so a fix to them reaches you with a package update. The `session_key` column lets `auth.updateSessionKey()` end an account's other sessions with every session driver. |
| `routes.ts`, `api-routes.ts` | The pages and forms, and `GET /api/user` for API tokens. |
| `home.ts` | `HOME`, the name of the route people land on after they sign in, register or confirm their address: `dashboard`. Change the name there and every sign-in, the guest pages (`guest({ homeRoute: HOME })`) and the layout follow. It names a route without path parameters. |
| `controllers/` | The controllers of the pages and forms in `routes.ts`. A form's controller validates it with a request schema. |
| `views/`, `layouts/` | The React pages and the app's layout, `AppLayout`, with a settings layout inside it. |
| `mail/` | Ten mails: the confirmation of an address, the reset link, the notes about a change of address and about a known address, the notes about the second factor and about passkeys, the note about a copied "keep me signed in" cookie, and the note that an account stopped taking passwords. |
| `jobs/`, `listeners/`, `commands/` | The work that runs on the queue, the listeners that react to events, and the command `auth:prune-unverified`. |
| `middleware/` | `ShareAuthProps` and `ConfirmedAddress`. |
| `migrations/` | The tables `users`, `password_reset_tokens`, `personal_access_tokens`, `two_factor_authentications` with `two_factor_recovery_codes`, `passkeys`, `sign_ins`, which also holds the remember-me tokens, and `email_changes`, where a change of address waits for its link. |
| `factories/`, `seeders/` | `UserFactory` for tests, and `UserSeeder` with `test@example.com` and the password `password`. The seeder runs only with `marmeon db:seed` or `migrate:fresh --seed`: never seed a server with it. |
| `schedule.ts` | The nightly clean-up of expired tokens and changes of address. |
| `*.test.ts` | The module's own tests, next to the code. |

`marmeon make:auth` also writes `marmeon-stubs.json` into the root of the app: for every file it copied, except the migrations, the
template it came from in `@marmeon/auth`, the version of the package and the hash of what it wrote (line endings do not count). Commit it with the
module. The file belongs to the framework, so do not edit it by hand; without it, where a file came from is unknown. `make:auth --force` also uses its hashes to tell a file of an earlier kit you left unchanged from one you changed. The migrations are not
in it: they belong to your app, and `make:auth --force` keeps the ones the app has and adds only those it lacks. They are append-only: a file the framework shipped never changes, so a later change of a kit table comes as a new migration. After a merge conflict in `marmeon-stubs.json`, take one side: the hashes then match that side. A file from a
newer Marmeon makes `make:auth` stop before it writes anything. `create-marmeon` writes the file first, with the sets
`create-marmeon:base` (and `create-marmeon:kit` for the starter kit); `make:auth` adds its own set to it.

The module is wiring and pages: the repository, the routes, the controllers, the views, the mails and the migrations. About
sign-ins, passwords, factors and sessions it decides nothing: the limits, the checks, the single-use links and the ending of sessions are
services of `@marmeon/auth`, which the controllers call; [what the package decides](authentication.md#what-the-package-decides) lists them, and a package update brings
their fixes. The stores come with the package too, so the module has no store of its own to keep up to date. What you could implement
yourself, and which members are required, is listed under [what your app implements](authentication.md#what-your-app-implements).

The module does decide a few things of its own, described under [private registration](#private-registration): that registration
answers alike, in the same time and with a hash, for a new and a taken address; how many mails go to one address and
the lock per recipient in `SendAccountExistsMailJob` and `SendEmailChangeMailJob`; `ConfirmedAddress`; and `auth:prune-unverified`.

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

A signed-in user who opens a guest page goes to `HOME` of `modules/auth/home.ts`, `/dashboard` as the module ships. A sign-in (password, second factor, passkey) goes to the page that asked for it, or to `HOME` when none did; `HOME` is a route name, so moving it is one edit. A view cannot import it into `<Link route>`, since the build reads route names written out, so the layout takes the URL from the page's `home` prop. The security page changes the password and the e-mail address,
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

Both stand in the cascade layer `kit`, which comes after the framework's `marmeon`. Your own CSS without a layer beats them
whatever its specificity, and a utility framework's classes win when its layers stand after `kit`: that is the order line at the
top of `styles/app.css`, and [With a utility framework](styling.md#with-a-utility-framework) shows it for Tailwind CSS.

`bootstrap/client.tsx` imports `styles/app.css` first, because the first stylesheet names the layer order, then the framework's
stylesheet, and `make:auth` adds `auth.css` after it. The module's rules use the tokens with a fallback, so `auth.css` also works
in an app that has a stylesheet of its own; your own rules without a layer beat the module's, even its
class rules, and so does a rule in a layer after `kit`. To change how plain elements look while the kit's classes still win,
edit the element rules in `styles/app.css`, which stand in `@layer kit`, or add yours inside `@layer kit { … }` after them.
Put a reset in `base` or another layer before `marmeon`.

A kit app from an earlier release: put `@layer base, marmeon, kit;` at the top of `styles/app.css` and keep the font `@import`
right below it, outside any block: an `@import` inside a block is invalid and dropped silently. Wrap the rest of the file and
`modules/auth/auth.css` in `@layer kit { … }`, and import `app.css` before `@marmeon/react/styles.css`. Do this before
`make:auth --force`, which writes `auth.css` in the layer.

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

`vite.config.ts` preloads the Latin subset of the font and gives it a stand-in, a local Arial sized to match
(`virtual:marmeon/fonts.css`, imported in `bootstrap/client.tsx`), so the text barely moves when the font arrives; see
[Fonts](vite.md#a-fallback-with-the-same-size). With another font, change `fonts` in `vite.config.ts` and the stack in `--font-text`.

## Two-factor authentication

Each user decides for their own account. On `/settings/two-factor` they scan a QR code with an authenticator app, type the first
code and their password, and get ten recovery codes in a layer, shown once. Turning it on signs out their other devices and lists
their API tokens, which keep working. From then on a sign-in with the right password waits on `/two-factor-challenge` for a code
or a recovery code. The settings page and new recovery codes sit behind sudo mode, which asks for a confirmation (the password or a passkey) again after 15 minutes by default ([how long](authentication.md#how-long-a-sign-in-lasts)); turning it off always asks for it.

The owner gets a mail when the factor is turned on or off, when a recovery code signed in (with the number left), and when a
wrong code followed the right password ("someone knows your password", at most once an hour for each account). They are queued
listeners in `listeners/`, and `mail/TwoFactorMail.ts` writes them in the account's language.

A user who lost the phone and the recovery codes is let in by an operator with `marmeon auth:reset-two-factor`, which comes with
`@marmeon/auth` ([operator reset](two-factor-authentication.md#operator-reset)). The kit stores addresses in lower case, so type it in lower case.

The kit does not require it anywhere: the `twoFactor()` middleware is provided and not installed. It comes with the page it
needs, `/settings/two-factor/verify`; [Two-Factor Authentication](two-factor-authentication.md#in-the-starter-kit) shows the line
that turns it on. To switch the feature off for every account, remove the `TwoFactorState` binding in `AuthServiceProvider.ts`, and the routes,
pages and listeners that use it.

## Passkeys

The login page has a button "Sign in with a passkey" (and the browser's autofill in the e-mail field offers them too), but only after the
page has loaded and only in a browser that has passkeys: without JavaScript there is the password form alone. A passkey signs in without a
password and without a second step. On `/settings/passkeys` a user adds a passkey with a name and **their password, for every passkey**, renames it, and removes it. The first passkey
turns on two-factor authentication: the page shows ten recovery codes once, and from then on a sign-in with the
password asks for a passkey, a code or a recovery code on `/two-factor-challenge`. A passkey that looks copied is suspended and shown with a form to release it.
What `Passkeys` decides on the way (the password for every change, the sessions it ends, the suspension) is on the
[passkeys](passkeys.md) page.

The owner gets a mail when a passkey is added, removed or suspended, and when a failed passkey sign-in tried one of theirs (at most once an
hour for each account). Passkeys survive a password reset, so a reset also mails the list of passkeys the account still has: whoever
reset the password, the owner sees what still signs in without it. `mail/PasskeyMail.ts` writes them in the account's language.

The owner also gets a mail when an old or forged "keep me signed in" cookie was sent (`RememberTokenReused`): every session and cookie of the
account was ended, and the mail names the time, the address and a parsed browser and system. It says plainly that it is usually someone who holds a copy, and that a browser of the owner can also send an old cookie when a page did not finish loading as it was renewed. `mail/SignInMail.ts` writes it in the account's language.

Passkeys need the relying party from `APP_URL`: open the app as exactly that address, `http://localhost:3000` while developing (not
`127.0.0.1`). [Passkeys](passkeys.md#in-the-starter-kit) explains the rest. To switch passkeys off, remove `PasskeyServiceProvider` from `index.ts`, `PasskeyStore` from the
binding in `AuthServiceProvider.ts`, and the routes, pages, listeners and imports of `@marmeon/auth/passkeys` that use them. The five
views that run a ceremony also import `@marmeon/auth/passkeys/browser`; remove those calls with the buttons that start them.

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
- **A change of address waits for its link.** The answer is the same for a free and a taken address.
  The owner of a taken address gets a note, and nothing changes.
  `EmailChange` of `@marmeon/auth` decides this ([changing the address](authentication.md#changing-the-address)).
  The module binds its `DatabaseEmailChanges` store, sends the mail and writes the address.

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

A boolean is allowed (`true`, `false`, `1`, `0`, in any case). Any other value stops the start; an empty one counts as unset. To demand a confirmed address with private registration
off, put `verified()` of `@marmeon/auth` in place of `ConfirmedAddress` in `routes.ts`. The routes that add an authenticator app or a passkey
demand a confirmed address in either mode, as does creating an API token, and the settings pages say so with a link to send the mail
again. The owner's password reset removes whatever an account with an unconfirmed address holds (factors and tokens). Set
`AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` as well for the other accounts, as the
[API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains.

## Mail, the queue and the scheduler

Every mail of the module goes through the queue, on its `mail` queue. A new app has the queue's table and `marmeon dev` starts a
worker, so this works from the first start. By default the mailer writes each mail to the log. On a server you need a real
mailer, `MAIL_DRIVER=smtp`, and a worker, `marmeon queue:work`. The [deployment](deployment.md) page shows both.

The scheduler deletes expired reset links and API tokens, takes expired remember-me tokens off their sign-ins and deletes the sign-ins that are over every night at 03:10, and the changes of address
that nobody confirmed in time. `marmeon dev` runs the scheduler for you. On a server, run `marmeon schedule:work`.

The mail that tells an owner the account's daily ceiling was reached is the kit's too: `QueueLockoutMail` queues `SendLockoutMailJob`
([limits on password sign-ins](authentication.md#limits-on-password-sign-ins)).

### Accounts nobody confirmed

`marmeon auth:prune-unverified` deletes the accounts whose address was never confirmed, once `AUTH_UNVERIFIED_DAYS` days have
passed since they signed up. It ends a registration with somebody else's address, and it keeps no data of sign-ups nobody
finished. An account that was confirmed once is never deleted.

The command is not scheduled by itself, because deleting accounts is your app's decision. Turn its line on in
`modules/auth/schedule.ts`:

```ts title="modules/auth/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
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
  migration, and make the tables that reference users use `foreignUuid()`: `sign_ins` and `personal_access_tokens` use
  `foreignId('user_id')`. Code that types a user id as a `number`, such as `UserRepository.findById(id: number)`, has to follow.
  Sessions, notifications and `AuthUserId` already allow a string.

`apps/web-app` in the framework's repository shows both: `users` has a `public_id`, and `profile_links` has a UUID as its
primary key.

## Adding a resource

`marmeon make:resource Bookmark` writes a whole module for a record that belongs to the signed-in user, in the kit's layout and
with the kit's classes: `modules/bookmarks/` with the table (a UUIDv7 key, `user_id`, a title), a repository, a policy,
the controllers to list, create, store, edit, update and delete, two pages, and a test. It adds the module to `bootstrap/app.ts`
and then tells you to run `marmeon migrate`, `marmeon db:types` and `marmeon route:types`. `apps/web-app` in the framework's
repository shows the module as the command writes it.

The module is safe to start from. The policy lets the owner in and answers everyone else with a 404
([generating a policy](authorization.md#generating-a-policy)), and every route that takes a record from the path checks it in its
request. The list asks for `ctx.user.id` only, a new record gets its owner from the session and not from the form, and the
test tries somebody else's record on every such route. Name the singular record in PascalCase; the module is its plural in kebab
case (`Category` → `categories`), or pass `--module=<name>`. The command stops before it writes anything when the module exists,
when `@marmeon/auth` is not in the app's `package.json`, or when the auth module and its layout are missing. Add the fields you
need to the migration, the two schemas and the form. A record with no owner, shared by all users, is not what the command
writes: [records nobody owns](authorization.md#records-nobody-owns) shows the routes for it. See [`make:*` generators](console.md#generators).

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
`modules/auth/` stays as it is unless you pass `--force`, which overwrites it with the templates, except `migrations/`: a migration that ran never changes, so `--force` keeps every migration of that name (whatever its timestamp) and writes only the ones the app lacks. It names a kept file that differs from the template, and stops without writing when `modules/auth/migrations` is a link or a file. It also deletes a file an earlier kit wrote that this one no longer ships, when `marmeon-stubs.json` shows the app left it unchanged, and names one you changed: that one stays, and is yours. Only regular files under `modules/auth/` are deleted, never a link. `--adapter=react` names the UI
adapter, and React is the only one with templates.

## Testing

The module brings its own tests: sign-in, registration with both values of `AUTH_PRIVATE_REGISTRATION`, the change of address
and the deletion of unconfirmed accounts. They run with the app's other tests:

```sh
pnpm test
```

`UserFactory` makes users in your own tests, with the password `password`, and `#modules/auth` exports it. The
[HTTP tests](http-tests.md#sessions-and-signing-in) page shows how to act as a signed-in user.
