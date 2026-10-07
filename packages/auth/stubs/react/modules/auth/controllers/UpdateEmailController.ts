import { AuthConfig, type Authenticated } from '@bespokecore/auth';
import { Clock } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import { Controller, defineRequest, ValidationError, type ContextOf, type HttpContext } from '@bespokecore/http';
import { trans, Translator, Translators } from '@bespokecore/i18n';
import { Mailer } from '@bespokecore/mail';
import { Queue } from '@bespokecore/queue';
import * as v from 'valibot';
import { EMAIL_CHANGE_MINUTES, newEmailChangeToken } from '../email-change.ts';
import { SendEmailChangeMailJob } from '../jobs/SendEmailChangeMailJob.ts';
import { EmailChangedMail } from '../mail/EmailChangedMail.ts';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

export const UpdateEmailRequest = defineRequest({
  // Nothing here asks the database — whether an address has an account is never told by the form (E146).
  schema: v.object({
    email: v.pipe(v.string(trans('auth.validation.email_any')), v.trim(), v.toLowerCase(), v.maxLength(255), v.email(trans('auth.validation.email_invalid'))),
  }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/**
 * A new address — on the security page, behind confirmedPassword(): a hijacked session must not take over the account by
 * changing the address and then resetting the password. Private registration (E146, the default): the change is pending — the
 * new address waits beside the old one, and a link goes to it; the account's address changes only once that link is clicked
 * (signed in). A free address and one another account has get the same answer in the same time: this request does the same
 * either way — one write, one job. The worker decides: the link to a free address, a note to the owner of a taken one.
 *
 * With `AUTH_PRIVATE_REGISTRATION=false` (E193) the address changes at once, unverified until confirmed, the old one is told —
 * and "taken" is a field error.
 */
export class UpdateEmailController extends Controller {
  static request = UpdateEmailRequest;

  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #queue: Queue;
  readonly #clock: Clock;
  readonly #translator: Translator;
  readonly #translators: Translators;
  readonly #verification: VerificationMailer;
  readonly #mailer: Mailer;
  readonly #private: boolean;

  constructor(
    connections: Connections,
    users: UserRepository,
    queue: Queue,
    clock: Clock,
    translator: Translator,
    translators: Translators,
    verification: VerificationMailer,
    mailer: Mailer,
    config: AuthConfig,
  ) {
    super();
    this.#connections = connections;
    this.#users = users;
    this.#queue = queue;
    this.#clock = clock;
    this.#translator = translator;
    this.#translators = translators;
    this.#verification = verification;
    this.#mailer = mailer;
    this.#private = config.privateRegistration;
  }

  async handle(ctx: ContextOf<typeof UpdateEmailRequest>) {
    const { email } = ctx.body;
    if (!this.#private) return this.#changeNow(ctx.user, email);
    // The account's own address again: a pending change is dropped.
    if (email === ctx.user.email) {
      await this.#users.cancelEmailChange(ctx.user.id);
      return this.back('/settings/security');
    }
    const { token, hash } = newEmailChangeToken();
    const expiresAt = new Date(this.#clock.now() + EMAIL_CHANGE_MINUTES * 60_000);
    // One transaction (E107): the pending change and its job, or neither. The job is composed by a worker, never here — a mail
    // rendered for one kind of address only would show in the time.
    await this.#connections.transaction(async () => {
      await this.#users.requestEmailChange(ctx.user.id, { email, tokenHash: hash, expiresAt });
      await this.#queue.dispatch(SendEmailChangeMailJob, { user: ctx.user.id, email, token, locale: this.#translator.locale }, { queue: 'mail' });
    });
    // The same answer for both — and no address in it.
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.email_change_sent') });
  }

  /** `AUTH_PRIVATE_REGISTRATION=false`: the new address at once — "taken" tells a signed-in user (in sudo mode) that it has an account. */
  async #changeNow(user: ContextOf<typeof UpdateEmailRequest>['user'], email: string) {
    if (email === user.email) return this.back('/settings/security');
    const updated = await this.#users.changeEmail(user.id, email);
    if (updated === 'duplicate') throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { email });
    if (!updated) return this.redirect().route('auth.login');
    // Both queued (composed now, sent by a worker): the answer does not wait for the mail server.
    await this.#verification.send(updated);
    // To the old address, in the user's language (not necessarily this request's).
    await this.#mailer.queue(new EmailChangedMail(user.name, user.email, email, this.#translators.for(user.locale)), { queue: 'mail' });
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.email_changed') });
  }
}
