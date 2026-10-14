import type { Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, type HttpContext } from '@marmeon/http';
import { CODES_LAYER } from '../two-factor-page.ts';

/** New recovery codes in place of all the old ones — a layer over the settings page that answers the POST, shown once. */
export class RegenerateRecoveryCodesController extends Controller {
  readonly #twoFactor: TwoFactor;

  constructor(twoFactor: TwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }

  async handle(_ctx: HttpContext<Authenticated>) {
    // Recovery codes belong to the account's factors, whichever they are: without one there is nothing to make them for.
    if ((await this.#twoFactor.status()).factors.length === 0) return this.redirect().route('auth.two-factor');
    return this.view('auth/RecoveryCodes', { codes: [...(await this.#twoFactor.regenerateRecoveryCodes())], tokens: null }).layer(CODES_LAYER);
  }
}
