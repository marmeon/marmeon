import { EmailVerification, type Authenticated } from '@marmeon/auth';
import { Clock } from '@marmeon/core';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { UserRepository } from '../UserRepository.ts';
import { HOME } from '../home.ts';

/** The link from the mail — behind authenticate() and signed(): made by the app, unexpired, and for this user’s current address. */
export class VerifyEmailController extends Controller {
  readonly #verification: EmailVerification;
  readonly #users: UserRepository;
  readonly #translator: Translator;
  readonly #clock: Clock;

  constructor(verification: EmailVerification, users: UserRepository, translator: Translator, clock: Clock) {
    super();
    this.#verification = verification;
    this.#users = users;
    this.#translator = translator;
    this.#clock = clock;
  }

  async handle(ctx: HttpContext<Authenticated, { id: string; hash: string }>) {
    // A valid signature proves the app made the link — not that it is yours.
    if (!this.#verification.matches(ctx.user, ctx.params)) abort(403, this.#translator.get('auth.verify.wrong_account'));
    if (ctx.user.email_verified_at === null) await this.#users.markEmailVerified(ctx.user.id, new Date(this.#clock.now()));
    return this.redirect().route(HOME).flash('toast', { kind: 'success', message: this.#translator.get('auth.verify.verified') });
  }
}
