import { Controller } from '@marmeon/http';
import { OfficeAuth } from './guard.ts';

/** The second step of the editors' sign-in: asks for the code. Without a sign-in that waits for it there is nothing to ask, so back to the password. */
export class ShowOfficeTwoFactorChallengeController extends Controller {
  static readonly inject = [OfficeAuth] as const;

  readonly #auth: OfficeAuth;

  constructor(auth: OfficeAuth) {
    super();
    this.#auth = auth;
  }

  handle() {
    const pending = this.#auth.pendingSecondFactor();
    if (pending === undefined) return this.redirect().route('office.login');
    // The page offers what the editor has: the authenticator app's code, a passkey, and always a recovery code.
    return this.view('office::Challenge', { step: 'sign-in' as const, totp: pending.factors.includes('totp'), passkey: pending.factors.includes('passkey') });
  }
}
