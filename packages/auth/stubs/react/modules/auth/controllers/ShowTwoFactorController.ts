import type { Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, type HttpContext } from '@marmeon/http';
import { twoFactorPage } from '../two-factor-page.ts';

/** The authenticator app and the recovery codes — behind confirmedPassword() ("sudo mode"). */
export class ShowTwoFactorController extends Controller {
  readonly #twoFactor: TwoFactor;

  constructor(twoFactor: TwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }

  async handle(_ctx: HttpContext<Authenticated>) {
    return this.view('auth/TwoFactor', await twoFactorPage(this.#twoFactor));
  }
}
