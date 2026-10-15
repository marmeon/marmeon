import { Auth, AuthConfig, type Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { RateLimiter } from '@marmeon/cache';
import { Clock } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator, Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { EMAIL_CHANGE_MINUTES, newEmailChangeToken } from '../email-change.ts';
import { SendEmailChangeMailJob } from '../jobs/SendEmailChangeMailJob.ts';
import { EmailChangedMail } from '../mail/EmailChangedMail.ts';
import { throttlePasswordChecks } from '../throttle.ts';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

export const UpdateEmailRequest = defineRequest({
  // Nothing here asks the database — whether an address has an account is never told by the form.
  schema: r.object({ email: r.string().trim().lowercase().required().max(255).email(), current_password: r.string().required().max(4096) }),
  messages: { 'email.required': 'auth.validation.email_any', 'email.email': 'auth.validation.email_invalid', 'current_password.required': 'auth.validation.current_password_required' },
});

/**
 * A new address — on the security page, behind confirmedPassword() and confirmedSecondFactor() (the controller asks for the
 * factor itself too), and with the current password in the same form: a passkey alone can confirm sudo mode, and a hijacked session must not take over the account by changing the address and then resetting the password. Private registration (the default): the change is pending — the
 * new address waits beside the old one, and a link goes to it; the account's address changes only once that link is clicked
 * (signed in). A free address and one another account has get the same answer in the same time: this request does the same
 * either way — one write, one job. The worker decides: the link to a free address, a note to the owner of a taken one.
 *
 * With `AUTH_PRIVATE_REGISTRATION=false` the address changes at once, unverified until confirmed, the old one is told —
 * and "taken" is a field error.
 */
export class UpdateEmailController extends Controller {
  static request = UpdateEmailRequest;

  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #twoFactor: TwoFactor;
  readonly #queue: Queue;
  readonly #clock: Clock;
  readonly #translator: Translator;
  readonly #translators: Translators;
  readonly #verification: VerificationMailer;
  readonly #mailer: Mailer;
  readonly #private: boolean;
  readonly #auth: Auth;
  readonly #limiter: RateLimiter;

  constructor(
    connections: Connections,
    users: UserRepository,
    twoFactor: TwoFactor,
    queue: Queue,
    clock: Clock,
    translator: Translator,
    translators: Translators,
    verification: VerificationMailer,
    mailer: Mailer,
    config: AuthConfig,
    auth: Auth,
    limiter: RateLimiter,
  ) {
    super();
    this.#connections = connections;
    this.#users = users;
    this.#twoFactor = twoFactor;
    this.#queue = queue;
    this.#clock = clock;
    this.#translator = translator;
    this.#translators = translators;
    this.#verification = verification;
    this.#mailer = mailer;
    this.#private = config.privateRegistration;
    this.#auth = auth;
    this.#limiter = limiter;
  }

  async handle(ctx: ContextOf<typeof UpdateEmailRequest> & Authenticated) {
    // Also without the route's confirmedSecondFactor(): a route added by hand to this controller must not skip the factor.
    await this.#twoFactor.requireRecentProof('changeEmail');
    // Typed now, whatever confirmed sudo mode: a session that got in by a passkey alone must not be able to move the account to another address.
    await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'current_password', () => this.#auth.confirmPassword(ctx.body.current_password));
    const { email } = ctx.body;
    if (!this.#private) return this.#changeNow(ctx.user, email);
    // The account's own address again: a pending change is dropped.
    if (email === ctx.user.email) {
      await this.#users.cancelEmailChange(ctx.user.id);
      return this.back('/settings/security');
    }
    const { token, hash } = newEmailChangeToken();
    const expiresAt = new Date(this.#clock.now() + EMAIL_CHANGE_MINUTES * 60_000);
    // One transaction: the pending change and its job, or neither. The job is composed by a worker, never here — a mail
    // rendered for one kind of address only would show in the time.
    await this.#connections.transaction(async () => {
      await this.#users.requestEmailChange(ctx.user.id, { email, tokenHash: hash, expiresAt });
      await this.#queue.dispatch(SendEmailChangeMailJob, { user: ctx.user.id, email, token, locale: this.#translator.locale }, { queue: 'mail' });
    });
    // The same answer for both — and no address in it.
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.email_change_sent') });
  }

  /** `AUTH_PRIVATE_REGISTRATION=false`: the new address at once — "taken" tells a signed-in user (in sudo mode) that it has an account. */
  async #changeNow(user: Authenticated['user'], email: string) {
    if (email === user.email) return this.back('/settings/security');
    const changed = await this.#users.changeEmail(user.id, email);
    if (!changed.ok) {
      if (changed.error.kind === 'duplicate') throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { email });
      return this.redirect().route('auth.login');
    }
    // Both queued (composed now, sent by a worker): the answer does not wait for the mail server.
    await this.#verification.send(changed.value);
    // To the old address, in the user's language (not necessarily this request's).
    await this.#mailer.queue(new EmailChangedMail(user.name, user.email, email, this.#translators.for(user.locale)), { queue: 'mail' });
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.email_changed') });
  }
}
