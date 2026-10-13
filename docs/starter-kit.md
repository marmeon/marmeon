# Starter Kit

## Introduction

The starter kit is what `pnpm create marmeon` gives you by default: a blank app plus two modules. The `auth` module handles
accounts: sign-in, registration, password reset, the confirmation of an address, a security page and API tokens. The `home`
module is the page at `/`. Both are ordinary modules in your app, written as source code, so you read them, change them and
delete what you do not need.

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
| `index.ts` | The module's definition: its provider, the listener that sends the confirmation mail, the queued jobs, the migrations, the seeder, the routes, the schedule and the `auth:prune-unverified` command. |
| `AuthServiceProvider.ts` | Finds users through the `UserRepository`, shares `auth` with every page, and sets the rate limits of its forms. |
| `users.ts`, `UserRepository.ts` | The `User` type and the only code that reads a password hash. |
| `routes.ts`, `api-routes.ts` | The pages and forms, and `GET /api/user` for API tokens. |
| `controllers/` | 24 controllers, one per endpoint. A form's controller validates it with a request schema. |
| `views/`, `layouts/` | The React pages and the app's layout, `AppLayout`, with a settings layout inside it. |
| `mail/` | Six mails: the confirmation of an address, the reset link, the notes about a change of address and about a known address. |
| `jobs/`, `listeners/`, `tasks/` | The work that runs on the queue or on a schedule. |
| `middleware/` | `ShareAuthProps` and `ConfirmedAddress`. |
| `migrations/` | The tables `users`, `remember_tokens`, `password_reset_tokens` and `personal_access_tokens`. |
| `factories/`, `seeders/` | `UserFactory` for tests, and `UserSeeder` with `test@example.com` and the password `password`. The seeder runs only with `marmeon db:seed` or `migrate:fresh --seed`: never seed a server with it. |
| `schedule.ts` | The nightly clean-up of expired tokens and changes of address. |
| `auth.test.ts` and three more | The module's own tests. |

To add a language, put a file next to every `en.ts` of the app — a locale with any language file is supported (see [Localization](localization.md), `APP_LOCALES`).

`apps/web-app` in the framework's repository shows such a module grown further, with a welcome mail.

## The pages

| Path | Name | Who |
| --- | --- | --- |
| `/login` | `auth.login` | guests |
| `/register` | `auth.register` | guests |
| `/register/sent` | `auth.register.sent` | guests, after they register |
| `/forgot-password`, `/reset-password` | `auth.password.request`, `auth.password.reset` | guests |
| `/dashboard` | `dashboard` | signed in, with a confirmed address |
| `/confirm-password` | `auth.password.confirm` | signed in, with a confirmed address |
| `/settings/security` | `auth.security` | the same, and the password typed within 15 minutes |
| `/settings/tokens` | `auth.tokens` | the same |
| `/email/verify` | `auth.verification.notice` | signed in |

A signed-in user who opens a guest page goes to `/dashboard`. The security page changes the password and the e-mail address,
and signs out the other devices. The tokens page creates and revokes API tokens. `/` belongs to the home module, so the auth
module leaves it free.

The routes are an ordinary route file, so you change a path, add a page or remove one in `modules/auth/routes.ts`. The
[routing](routing.md#route-files) page explains route files.

## Private registration

The registration never tells anyone whether an address already has an account. A new address and a known one get the same
answer in the same time: a redirect to `/register/sent`, which asks the person to check their inbox. The owner of a known address
gets a mail instead of the confirmation link: someone tried to sign up with it, and here is how to sign in or reset the password.
This keeps a stranger from testing a list of addresses against your users.

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
import { defineRoutes } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(verified()).get('/notes', ListNotesController).name('notes.index');
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
off, put `verified()` of `@marmeon/auth` in place of `ConfirmedAddress` in `routes.ts`. Set `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`
as well: an account registered with somebody else's address may have created an API token, and the owner's password reset then
ends it, as the [API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains.

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
  migration, and make the tables that reference users use `foreignUuid()`: `remember_tokens` and `personal_access_tokens` use
  `foreignId('user_id')`. Code that types a user id as a `number`, such as `UserRepository.findById(id: number)`, has to follow.
  Sessions, notifications and `AuthUserId` already allow a string.

`apps/web-app` in the framework's repository shows both: `users` has a `public_id`, and `profile_links` has a UUID as its
primary key.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_PRIVATE_REGISTRATION` | `true` | `false` makes the registration and the change of address say "taken", and signs a new account in at once. |
| `AUTH_UNVERIFIED_DAYS` | `7` | Days an account may stay without a confirmed address before `auth:prune-unverified` deletes it. `0`: the command deletes none. |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | `false` | `true`: a new password and a password reset revoke every API token of the user. Set it with `AUTH_PRIVATE_REGISTRATION=false`. |

The [authentication](authentication.md#configuration) page lists the other `AUTH_*` variables, such as how long "remember me" lasts.

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
