import { Auth } from '@marmeon/auth';
import { Controller } from '@marmeon/http';

/** The second step of signing in: asks for the code. Without a sign-in that waits for it, there is nothing to ask — back to the login. */
export class ShowTwoFactorChallengeController extends Controller {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }

  handle() {
    const pending = this.#auth.pendingSecondFactor();
    if (pending === undefined) return this.redirect().route('auth.login');
    // Which factors the account has: the page offers the authenticator app's code and a passkey accordingly (recovery codes always).
    return this.view('auth/TwoFactorChallenge', { totp: pending.factors.includes('totp'), passkey: pending.factors.includes('passkey') });
  }
}
