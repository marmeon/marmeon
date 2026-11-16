import { Controller } from '@marmeon/http';
import { OfficeTwoFactor } from './guard.ts';

/** Makes a new key and shows it on the security page (QR code and text); it is not in force until a code from the app confirms it. */
export class OfficeBeginTwoFactorController extends Controller {
  static readonly inject = [OfficeTwoFactor] as const;

  readonly #twoFactor: OfficeTwoFactor;

  constructor(twoFactor: OfficeTwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }

  async handle() {
    // Already on: nothing to begin (`begin()` would throw; turn it off first).
    if (!(await this.#twoFactor.status()).factors.includes('totp')) await this.#twoFactor.begin();
    return this.redirect().route('office.security');
  }
}
