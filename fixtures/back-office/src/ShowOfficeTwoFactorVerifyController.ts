import { Controller } from '@marmeon/http';
import { OfficeTwoFactor } from './guard.ts';

/** Asks a signed-in editor for the second factor again: `confirmedSecondFactor()` sends a session that has not proven one lately (15 minutes) here. */
export class ShowOfficeTwoFactorVerifyController extends Controller {
  static readonly inject = [OfficeTwoFactor] as const;

  readonly #twoFactor: OfficeTwoFactor;

  constructor(twoFactor: OfficeTwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }

  async handle() {
    const { factors } = await this.#twoFactor.status();
    return this.view('office::Challenge', { step: 'verify' as const, totp: factors.includes('totp'), passkey: factors.includes('passkey') });
  }
}
