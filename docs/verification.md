# Email Verification

## Introduction

An account is only as trustworthy as its address. Anyone can type somebody else's address into a registration form, so an app
confirms that the person behind an account reads mail at that address: it mails a link, and the account counts as confirmed once
the link is opened. The [starter kit](starter-kit.md) does all of this. This page explains the parts, so you can guard your own
routes and change the flow.

A route that needs a confirmed address puts `verified()` after `authenticate()`:

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';

export default defineRoutes((Route) => {
  const confirmed = Route.middleware(authenticate()).middleware(verified());
  confirmed.get('/notes', ListNotesController).name('notes.index');
  confirmed.post('/notes', StoreNoteController).name('notes.store');
});
```

## Requiring a confirmed address

`verified()` lets a user through whose `email_verified_at` is set. A browser goes to the notice page, the route named
`auth.verification.notice`, and a client that expects JSON gets `403 {"message":"Your e-mail address is not verified."}`.
`verified({ noticeRoute })` names another notice page. The user type needs the column `email_verified_at`; a user whose provider
did not load it counts as unconfirmed.

The starter kit puts its own middleware, `ConfirmedAddress`, on the pages of the auth module. While the registration is private,
the default, it is `verified()`. With `AUTH_PRIVATE_REGISTRATION=false` it lets every signed-in user through.

> [!WARNING]
> `ConfirmedAddress` guards the auth module's pages alone. A route of your own behind `authenticate()` alone lets in every
> signed-in account, also one registered with somebody else's address that nobody confirmed. Put `verified()` after
> `authenticate()` on every route of your own that signed-in users reach.

`verified()` asks for a confirmed address whatever `AUTH_PRIVATE_REGISTRATION` says. The two modes differ in when an unconfirmed
account can sign in at all:

- **Private registration, the default.** Registering signs nobody in. The new account signs in like any other and sees only the
  notice until its owner opens the link while signed in. Whoever registered with somebody else's address cannot confirm it, and
  the real owner takes the account over with a password reset.
- **Open registration, `AUTH_PRIVATE_REGISTRATION=false`.** A new account is signed in at once and uses the app's pages without a
  confirmed address, unless those pages ask for `verified()`. Whoever registered with somebody else's address has a working
  account until the owner takes it over with a password reset, and an API token they created in the meantime survives that reset.
  A change of address takes effect at once and leaves the account unconfirmed until the new address is confirmed.

The [starter kit](starter-kit.md#private-registration) page explains both modes and what each tells a stranger.

## The verification link

`EmailVerification` makes the link and checks it. The link is a signed URL that expires, and it carries the user's id and a
SHA-256 hash of their address in lower case:

```ts title="modules/auth/verification.ts"
import { EmailVerification } from '@marmeon/auth';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { AppConfig } from '../../config/app.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { User } from './users.ts';

export class VerificationMailer {
  readonly #verification: EmailVerification;
  readonly #mailer: Mailer;
  readonly #app: AppConfig;
  readonly #translators: Translators;

  constructor(verification: EmailVerification, mailer: Mailer, app: AppConfig, translators: Translators) {
    this.#verification = verification;
    this.#mailer = mailer;
    this.#app = app;
    this.#translators = translators;
  }

  async send(user: User): Promise<void> {
    const link = this.#verification.link(user, { base: this.#app.url });
    await this.#mailer.queue(new VerifyEmailMail(user, link, this.#translators.for(user.locale)), { queue: 'mail' });
  }
}
```

`link(user, { base, expiresIn, route })` signs the route `auth.verification.verify` for 60 minutes by default. `base` is the
app's address from `APP_URL`, never a request's `Host` header, so nobody can make a mail point elsewhere. The mail is written in
the language stored with the account, not the request's.

The route behind the link sits behind `authenticate()` and `signed()`, and is internal, since only the server builds its links:

```ts title="modules/auth/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, signed } from '@marmeon/http';
import { VerifyEmailController } from './controllers/VerifyEmailController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(signed()).get('/email/verify/:id/:hash', VerifyEmailController).name('auth.verification.verify').internal();
});
```

The controller asks `matches()` before it marks the address confirmed:

```ts title="modules/auth/controllers/VerifyEmailController.ts"
import { EmailVerification, type Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { UserRepository } from '../UserRepository.ts';

export class VerifyEmailController extends Controller {
  readonly #verification: EmailVerification;
  readonly #users: UserRepository;

  constructor(verification: EmailVerification, users: UserRepository) {
    super();
    this.#verification = verification;
    this.#users = users;
  }

  async handle(ctx: HttpContext<Authenticated, { id: string; hash: string }>) {
    if (!this.#verification.matches(ctx.user, ctx.params)) abort(403, 'This link is for another account.');
    if (ctx.user.email_verified_at === null) await this.#users.markEmailVerified(ctx.user.id);
    return this.redirect().route('dashboard');
  }
}
```

Each check closes a gap:

- **`signed()`** proves the app made the link and that it has not expired. A changed id or hash breaks the signature.
- **`matches(user, params)`** compares the link with the signed-in user, in constant time. A valid link of somebody else, opened
  while signed in, is `false`: the signature proves who made the link, not whose it is.
- **The address hash** ties the link to the address it was sent to. Once the address changes, every older link stops working.
- **`authenticate()`** makes the owner sign in first. A guest who opens the link goes to the login and comes back to the link
  afterwards.

`markEmailVerified()` sets `email_verified_at` and, the first time, `first_verified_at`, which the clean-up of unconfirmed accounts
reads.

## Sending the mail

The registration dispatches `Registered`, and a queued listener sends the mail. The starter kit registers it in the module with
`listen(Registered, SendEmailVerification)`:

```ts title="modules/auth/listeners/SendEmailVerification.ts"
import type { Registered } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

export class SendEmailVerification {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #users: UserRepository;
  readonly #mailer: VerificationMailer;

  constructor(users: UserRepository, mailer: VerificationMailer) {
    this.#users = users;
    this.#mailer = mailer;
  }

  async handle(payload: EventPayload<typeof Registered>): Promise<void> {
    const user = await this.#users.find(payload.userId);
    if (!user || user.email_verified_at !== null) return;
    await this.#mailer.send(user);
  }
}
```

The listener is queued inside the registration's transaction, so an account that is rolled back gets no mail, and a failing mail
server never fails a registration: the job tries again. Nothing goes out without a queue worker, which `marmeon dev` starts for
you.

The notice page offers to send the mail again. Its route, `auth.verification.send`, allows three requests a minute per user with
`throttle('verification')`.

## Changing the address

With private registration, a new address on the security page waits beside the old one until the link sent to it is opened:

- **The same answer for every address.** The request stores the pending address and queues one job, whether the address is free or
  belongs to another account. The worker sends the link to a free address, and a note to the owner of a taken one. Nothing changes
  for anybody until a link is opened.
- **One link, one request.** The users table keeps the pending address, the SHA-256 hash of the link's token and when it expires,
  60 minutes after the request. A newer request replaces the link. The link works only for the signed-in account it names, only
  once and only before it expires.
- **Confirmed by the click.** The new address becomes the account's, confirmed, and the old address gets a note. When another
  account took the address in the meantime, the click is refused with 409 and nothing changes.

The change page sits behind `confirmedPassword()` and allows six requests a minute per user, since every request sends a mail. A
pending address signs nobody in and gets no reset link. Typing the account's own address again drops a pending change, and the
scheduler clears expired ones every night.

With `AUTH_PRIVATE_REGISTRATION=false`, the address changes at once, unconfirmed, and a confirmation link goes to it. A taken
address is a field error, and the old address gets a note about the change.

## Unconfirmed accounts

`marmeon auth:prune-unverified`, a command of the starter kit's auth module, deletes the accounts whose address was never
confirmed, once `AUTH_UNVERIFIED_DAYS` days have passed since they signed up:

```sh
pnpm marmeon auth:prune-unverified
```

It ends a registration with somebody else's address, and keeps no data of sign-ups nobody finished. It deletes an account only when
all three hold:

- `email_verified_at` is empty,
- `first_verified_at` is empty: the account was never confirmed, not even once before a later change of address,
- the account was made more than `AUTH_UNVERIFIED_DAYS` days ago, 7 by default. A later change does not extend it.

The delete checks all three again in the same statement, so an account confirmed a moment ago stays. `AUTH_UNVERIFIED_DAYS=0`
deletes none. The command works in batches of 100 accounts and logs how many it deleted.

Each deletion goes through the module's `AccountDeletion`: the row, with its remember-me and API tokens, its reset token, and what
other modules keep for it, all in one transaction; then its sessions. Another module clears its own data by listening to
`AccountDeleted`:

```ts title="modules/user-profile/listeners/DeleteAvatar.ts"
import { afterCommit } from '@marmeon/core';
import { Storage } from '@marmeon/storage';
import type { AccountDeleted } from '#modules/auth';

export class DeleteAvatar {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async handle(event: AccountDeleted): Promise<void> {
    const path = event.user.avatar_path;
    if (!path) return;
    await afterCommit(() => this.#storage.disk('public').delete(path).catch(() => false));
  }
}
```

The listener runs inside the deletion's transaction. Its database writes roll back with it, and a file goes only after the
commit.

The command is not scheduled by itself, because deleting accounts is your app's decision. The
[starter kit](starter-kit.md#accounts-nobody-confirmed) page shows the line in `modules/auth/schedule.ts` that turns it on.

> [!WARNING]
> Deleting an account cannot be undone. With `AUTH_PRIVATE_REGISTRATION=false`, an unconfirmed account was signed in at once and
> may have used the app before it goes. Tell your users, or raise `AUTH_UNVERIFIED_DAYS`. Leave the schedule off where unconfirmed
> accounts belong to your model, such as invited team members or imported users.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_UNVERIFIED_DAYS` | `7` | Days an account may stay without a confirmed address before `auth:prune-unverified` deletes it. A whole number; `0` deletes none. |
| `AUTH_PRIVATE_REGISTRATION` | `true` | Whether registration and the change of address keep quiet about known addresses. Only `true` and `false` start. |

## Testing

`UserFactory` makes confirmed users. Its `unverified` state makes one without a confirmed address:

```ts title="modules/notes/verification.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('sends an unconfirmed account to the notice', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).state('unverified').create();
  await app.actingAs(ada).get('/notes').assertRedirect('/email/verify');
});
```

The [HTTP tests](http-tests.md) page covers signing in for tests.
