import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller } from '@marmeon/http';

/** Asks a signed-in session for its second factor again — where `twoFactor()` sends a session that has not proven it (or not recently enough). */
export class ShowTwoFactorVerifyController extends Controller {
  readonly #twoFactor: TwoFactor;

  constructor(twoFactor: TwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }

  async handle() {
    // Which factors the account has: the page offers the authenticator app's code and a passkey accordingly (recovery codes always).
    const { factors } = await this.#twoFactor.status();
    return this.view('auth/TwoFactorVerify', { totp: factors.includes('totp'), passkey: factors.includes('passkey') });
  }
}
