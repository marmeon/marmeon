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
    if (this.#auth.pendingSecondFactor() === undefined) return this.redirect().route('auth.login');
    return this.view('auth/TwoFactorChallenge', {});
  }
}
