import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller } from '@marmeon/http';

/** Makes a new key and shows it on the settings page (QR code and text) — not in force until a code from the app confirms it. */
export class BeginTwoFactorController extends Controller {
  readonly #twoFactor: TwoFactor;

  constructor(twoFactor: TwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }

  async handle() {
    // Already on: nothing to begin (begin() would throw — turn it off first).
    if (!(await this.#twoFactor.status()).factors.includes('totp')) await this.#twoFactor.begin();
    return this.redirect().route('auth.two-factor');
  }
}
