import { AuthConfig, type Authenticated } from '@marmeon/auth';
import { Clock } from '@marmeon/core';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator, Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { emailChangeTokenHash } from '../email-change.ts';
import { EmailChangedMail } from '../mail/EmailChangedMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * The link from ConfirmNewEmailMail (private registration) — behind authenticate() and signed(): made by the app and
 * unexpired. It works for the signed-in account it names, with the token of that account's current request, once: then the
 * pending address is the account's (confirmed — the click came from its inbox) and the old address is told. Whoever clicks it
 * signed in as somebody else changes nothing: the address someone typed never joins another account. With
 * `AUTH_PRIVATE_REGISTRATION=false` no change waits for a link: 404, as if the route were not there.
 */
export class ConfirmEmailChangeController extends Controller {
  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #clock: Clock;
  readonly #translator: Translator;
  readonly #translators: Translators;
  readonly #private: boolean;

  constructor(users: UserRepository, mailer: Mailer, clock: Clock, translator: Translator, translators: Translators, config: AuthConfig) {
    super();
    this.#private = config.privateRegistration;
    this.#users = users;
    this.#mailer = mailer;
    this.#clock = clock;
    this.#translator = translator;
    this.#translators = translators;
  }

  async handle(ctx: HttpContext<Authenticated, { id: string; token: string }>) {
    if (!this.#private) abort(404);
    // A valid signature proves the app made the link — not that it is yours.
    if (ctx.params.id !== String(ctx.user.id)) abort(403, this.#translator.get('auth.email_change.wrong_account'));
    const changed = await this.#users.confirmEmailChange(ctx.user.id, emailChangeTokenHash(ctx.params.token), new Date(this.#clock.now()));
    if (changed === 'invalid') abort(403, this.#translator.get('auth.email_change.invalid'));
    // Registered (or changed to) by another account since: the unique index decided, the request is gone.
    if (changed === 'taken') abort(409, this.#translator.get('auth.email_change.taken'));
    // To the old address, in the user's language (not necessarily this request's).
    await this.#mailer.queue(new EmailChangedMail(ctx.user.name, changed.previous, changed.user.email, this.#translators.for(ctx.user.locale)), { queue: 'mail' });
    return this.redirect().route('dashboard').flash('toast', { kind: 'success', message: this.#translator.get('auth.email_change.done', { email: changed.user.email }) });
  }
}
