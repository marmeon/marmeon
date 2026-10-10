# Password Reset

## Introduction

A user who forgot their password asks for a link, gets it by mail, and chooses a new password with it. `PasswordBroker` of
`@marmeon/auth` makes the link's token and checks it; the [starter kit](starter-kit.md) brings the pages, the mail and the
controllers. The form that asks for a link does the same whether the address has an account or not:

```ts title="modules/auth/controllers/SendPasswordResetLinkController.ts"
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { SendPasswordResetLinkJob } from '../jobs/SendPasswordResetLinkJob.ts';

export const SendPasswordResetLinkRequest = defineRequest({
  schema: r.object({ email: r.string().trim().lowercase().required().max(255).email() }),
});

export class SendPasswordResetLinkController extends Controller {
  static request = SendPasswordResetLinkRequest;

  readonly #queue: Queue;
  readonly #translator: Translator;

  constructor(queue: Queue, translator: Translator) {
    super();
    this.#queue = queue;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof SendPasswordResetLinkRequest>) {
    await this.#queue.dispatch(SendPasswordResetLinkJob, { email: ctx.body.email, locale: this.#translator.locale }, { queue: 'mail' });
    return this.back('/forgot-password').flash('toast', { kind: 'success', message: this.#translator.get('auth.forgot.sent') });
  }
}
```

The request only queues a job. A known and an unknown address get the same answer in the same time, so the form tells a stranger
nothing about who has an account.

## Asking for a link

The job looks the account up, makes the token and queues the mail:

```ts title="modules/auth/jobs/SendPasswordResetLinkJob.ts"
import { AuthConfig, PasswordBroker } from '@marmeon/auth';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobPayload } from '@marmeon/queue';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { AppConfig } from '../../../config/app.ts';
import { ResetPasswordMail } from '../mail/ResetPasswordMail.ts';

export class SendPasswordResetLinkJob {
  static readonly job = 'auth.send-password-reset-link';
  static readonly schema = r.object({ email: r.string(), locale: r.string() });
  static readonly encrypted = true;

  readonly #broker: PasswordBroker;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #router: Router;
  readonly #app: AppConfig;
  readonly #auth: AuthConfig;

  constructor(broker: PasswordBroker, mailer: Mailer, translators: Translators, router: Router, app: AppConfig, auth: AuthConfig) {
    this.#broker = broker;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#router = router;
    this.#app = app;
    this.#auth = auth;
  }

  async handle(payload: JobPayload<typeof SendPasswordResetLinkJob>): Promise<void> {
    const reset = await this.#broker.createToken(payload.email);
    if (!reset) return;
    const url = new URL(this.#router.url('auth.password.reset', {}, { token: reset.token, email: payload.email }), this.#app.url);
    const t = this.#translators.for(reset.user.locale ?? payload.locale);
    await this.#mailer.queue(new ResetPasswordMail(reset.user, url.href, this.#auth.resetExpire, t), { queue: 'mail' });
  }
}
```

`createToken(email)` returns the user and a new token, or `undefined`: for an address without an account, and while the last token
for that address is younger than `AUTH_RESET_THROTTLE` seconds, 60 by default. So one address gets at most one mail a minute,
however often someone asks.

- **The token** is 256 random bits. The `password_reset_tokens` table keeps only its SHA-256 hash, one row per address: a new
  token replaces the older one, and with it the older link.
- **The job's payload is encrypted,** because it holds an address. The mail is queued once more on its own, so a failing mail
  server retries the mail with this token instead of asking the broker for a second one.
- **The link comes from `APP_URL`,** never from a request's `Host` header, so nobody can make the mail point to another site.

The starter kit also limits the form to five requests a minute per client with `throttle('password-reset')`.

## The link

The link carries the token in its query. `ShowResetPasswordController` takes it out at once: it stores the address and the token
in a cookie, and sends the browser to the same page without them:

```ts title="modules/auth/controllers/ShowResetPasswordController.ts"
import { Controller, type HttpContext } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

export class ShowResetPasswordController extends Controller {
  readonly #router: Router;

  constructor(router: Router) {
    super();
    this.#router = router;
  }

  handle(ctx: HttpContext) {
    const token = ctx.query.get('token');
    const email = ctx.query.get('email');
    if (token && email) {
      ctx.cookies.set(RESET_COOKIE, JSON.stringify({ email: email.trim().toLowerCase(), token }), {
        path: this.#router.url('auth.password.reset'),
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60,
      });
      return this.redirect().route('auth.password.reset');
    }
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    return this.view('auth/ResetPassword', { email: reset?.email ?? null });
  }
}
```

The cookie is encrypted like every cookie of the `web` group, `HttpOnly`, and sent only to the reset page's path. So the token stays
out of the browser's history, out of the page's props and out of the `Referer` of anything the page loads. The request log writes
paths only, so it never sees the query either.

## Resetting the password

The form posts the new password, and `reset(email, token, password)` sets it:

```ts title="modules/auth/controllers/ResetPasswordController.ts"
import { password, PasswordBroker } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

export const ResetPasswordRequest = defineRequest({
  schema: r.object({ password: password(), password_confirmation: r.string() }).confirmed('password'),
});

export class ResetPasswordController extends Controller {
  static request = ResetPasswordRequest;

  readonly #broker: PasswordBroker;
  readonly #router: Router;

  constructor(broker: PasswordBroker, router: Router) {
    super();
    this.#broker = broker;
    this.#router = router;
  }

  async handle(ctx: ContextOf<typeof ResetPasswordRequest>) {
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    if (!reset || !(await this.#broker.reset(reset.email, reset.token, ctx.body.password))) {
      throw new ValidationError({ password: ['This reset link is invalid or has expired.'] });
    }
    ctx.cookies.delete(RESET_COOKIE, { path: this.#router.url('auth.password.reset') });
    return this.redirect().route('auth.login');
  }
}
```

`reset()` returns the user, or `undefined` for every failure alike: an unknown address, a wrong token, one used before, or one
older than `AUTH_RESET_EXPIRE` minutes, 60 by default. A token works once. Two requests with the same token cannot both succeed:
the token is deleted with a condition on its hash, and only one delete finds it.

A successful reset:

- stores a new hash, so every session of the user ends at its next request,
- deletes every remember-me token of the user,
- with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, revokes every API token of the user, in the same transaction as the new hash,
- dispatches `PasswordReset`, with `revokedTokens`, the number of API tokens it revoked.

It does not sign the user in: the starter kit sends them to the login page. The `password()` rule is explained on the
[hashing](hashing.md#the-password-rule) page.

A reset is often the answer to a stolen password, and whoever had the password may have created an API token with it. By default the
tokens stay valid after a reset. Set `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` to end them with the reset, as the
[API tokens](api-tokens.md#revoking-every-token-with-a-new-password) page explains.

## Old tokens

A token that is never used stays in the table until it is replaced or pruned. `marmeon auth:prune-tokens` deletes the reset
tokens older than `AUTH_RESET_EXPIRE`, together with expired remember-me and API tokens, and the starter kit runs it every night.
The [API tokens](api-tokens.md#pruning-tokens) page describes the command.

## A store of your own

The broker keeps its tokens in a `PasswordResetTokenStore`, by default the `password_reset_tokens` table. To keep them elsewhere,
bind your own in a provider:

```ts
interface PasswordResetTokenStore {
  create(email: string, throttleSeconds: number): Promise<string | undefined>;
  consume(email: string, token: string, maxAgeSeconds: number): Promise<boolean>;
  forget(email: string): Promise<void>;
  prune(maxAgeSeconds: number): Promise<number>;
}
```

`create()` returns `undefined` while the last token of the address is younger than `throttleSeconds`. `consume()` returns `true`
only for the current, fresh token of the address, and uses it up in the same step. Store a hash of the token, never the token.

A `password_reset_tokens` table of your own needs what the starter kit's migration gives it: `email` as its primary key, so an
address never has two rows, and `token_hash` as a 64-character `secret()` column.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_RESET_EXPIRE` | `60` | Minutes a reset link works. At least 1. |
| `AUTH_RESET_THROTTLE` | `60` | Seconds before another link goes to the same address. `0` sends one for every request. |
| `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE` | `false` | `true`: a reset, and every other new password, revokes every API token of the user. |

## Testing

A test reads the queued job instead of a real inbox. The [fakes](fakes.md) page shows how to fake the queue and the mailer, and the
[HTTP tests](http-tests.md) page how to post a form.
