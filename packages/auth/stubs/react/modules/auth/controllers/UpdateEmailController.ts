import type { Authenticated } from '@bespokecore/auth';
import { Controller, defineRequest, ValidationError, type ContextOf, type HttpContext } from '@bespokecore/http';
import { Mailer } from '@bespokecore/mail';
import * as v from 'valibot';
import { EmailChangedMail } from '../mail/EmailChangedMail.ts';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

export const UpdateEmailRequest = defineRequest({
  schema: v.object({
    email: v.pipe(v.string('Enter an e-mail address.'), v.trim(), v.toLowerCase(), v.maxLength(255), v.email('Enter a valid e-mail address.')),
  }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/**
 * A new address — on the security page, behind confirmedPassword(): a hijacked session must not take
 * over the account by changing the address and then resetting the password. The new address is
 * unverified until confirmed; the old one is told.
 */
export class UpdateEmailController extends Controller {
  static request = UpdateEmailRequest;

  readonly #users: UserRepository;
  readonly #verification: VerificationMailer;
  readonly #mailer: Mailer;

  constructor(users: UserRepository, verification: VerificationMailer, mailer: Mailer) {
    super();
    this.#users = users;
    this.#verification = verification;
    this.#mailer = mailer;
  }

  async handle(ctx: ContextOf<typeof UpdateEmailRequest>) {
    const { email } = ctx.body;
    if (email === ctx.user.email) return this.back('/settings/security');
    const updated = await this.#users.changeEmail(ctx.user.id, email);
    if (updated === 'duplicate') throw new ValidationError({ email: ['This e-mail address is already registered.'] }, { email });
    if (!updated) return this.redirect().route('auth.login');
    await this.#verification.send(updated);
    await this.#mailer.send(new EmailChangedMail(ctx.user.name, ctx.user.email, email));
    return this.back('/settings/security').with('status', 'E-mail address changed. Please confirm the new one — we sent you a link.');
  }
}
