import { createHash } from 'node:crypto';
import { type Authenticated, EmailChange } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { SendEmailChangeMailJob } from '../jobs/SendEmailChangeMailJob.ts';
import { passwordCheckMessage } from '../password-errors.ts';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

export const UpdateEmailRequest = defineRequest({
  // Nothing here asks the database — whether an address has an account is never told by the form.
  schema: r.object({ email: r.string().trim().lowercase().required().max(255).email(), current_password: r.string().required().max(4096) }),
  messages: { 'email.required': 'auth.validation.email_any', 'email.email': 'auth.validation.email_invalid', 'current_password.required': 'auth.validation.current_password_required' },
});

/**
 * A new address — on the security page, behind confirmedPassword() and confirmedSecondFactor(), with the current password in the same
 * form. `EmailChange` decides everything that matters for security (the factor, the password under its throttle, the single-use link
 * bound to this account); this controller wires it to the `users` table, the queue and the texts. Private registration (the default):
 * the change waits and a worker mails the link, the same for a free address and a taken one. With `AUTH_PRIVATE_REGISTRATION=false`
 * the address changes at once, unverified, and "taken" is a field error. The old address is told by the `EmailChanged` listener.
 */
export class UpdateEmailController extends Controller {
  static request = UpdateEmailRequest;

  readonly #emailChange: EmailChange;
  readonly #users: UserRepository;
  readonly #queue: Queue;
  readonly #translator: Translator;
  readonly #verification: VerificationMailer;
  readonly #limiter: RateLimiter;

  constructor(emailChange: EmailChange, users: UserRepository, queue: Queue, translator: Translator, verification: VerificationMailer, limiter: RateLimiter) {
    super();
    this.#emailChange = emailChange;
    this.#users = users;
    this.#queue = queue;
    this.#translator = translator;
    this.#verification = verification;
    this.#limiter = limiter;
  }

  async handle(ctx: ContextOf<typeof UpdateEmailRequest> & Authenticated) {
    const { email, current_password: password } = ctx.body;
    // The account's own address again: a pending change is dropped.
    if (email === ctx.user.email) {
      await this.#emailChange.cancel();
      return this.back('/settings/security');
    }
    const requested = await this.#emailChange.request(email, password, {
      // The job is composed by a worker, never here: a mail rendered for one kind of address only would show in the time.
      deliver: async (change) => {
        await this.#queue.dispatch(SendEmailChangeMailJob, { user: ctx.user.id, email: change.email, token: change.token, locale: this.#translator.locale }, { queue: 'mail' });
      },
      apply: (id, address, verifiedAt) => this.#users.applyEmailChange(id, address, verifiedAt),
    });
    if (!requested.ok) {
      if (requested.error.kind === 'duplicate') throw new ValidationError({ email: [this.#translator.get('auth.validation.email_taken')] }, { email });
      throw new ValidationError({ current_password: [passwordCheckMessage(this.#translator, requested.error)] });
    }
    // The same answer for a free address and a taken one — and no address in it.
    if (requested.value.pending) return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.email_change_sent') });
    // Without private registration the address is written at once, so there is no pause between requests: at most one confirmation mail an
    // hour goes to an address, or an account could alternate two requests and fill a stranger's inbox. The address is changed all the same.
    if (await this.#limiter.attempt(`email-change-verification:${createHash('sha256').update(email).digest('hex')}`, 1, 3600)) await this.#verification.send(requested.value.value);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.email_changed') });
  }
}
