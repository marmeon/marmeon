import { EmailVerification, type Authenticated } from '@bespokecore/auth';
import { abort, Controller, type HttpContext } from '@bespokecore/http';
import { UserRepository } from '../UserRepository.ts';

/** The link from the mail — behind authenticate() and signed(): made by the app, unexpired, and for this user’s current address. */
export class VerifyEmailController extends Controller {
  readonly #verification: EmailVerification;
  readonly #users: UserRepository;

  constructor(verification: EmailVerification, users: UserRepository) {
    super();
    this.#verification = verification;
    this.#users = users;
  }

  async handle(ctx: HttpContext<Authenticated, { id: string; hash: string }>) {
    // A valid signature proves the app made the link — not that it is yours.
    if (!this.#verification.matches(ctx.user, ctx.params)) abort(403, 'This verification link is not for your account.');
    if (ctx.user.email_verified_at === null) await this.#users.markEmailVerified(ctx.user.id);
    return this.redirect().route('user-profile.me').with('status', 'Your e-mail address is verified.');
  }
}
