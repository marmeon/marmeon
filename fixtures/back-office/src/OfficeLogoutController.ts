import { Controller } from '@marmeon/http';
import { OfficeAuth } from './guard.ts';

/** Signs the editor out. The browser's session ends, so a customer signed in to the app in the same browser is signed out with it. */
export class OfficeLogoutController extends Controller {
  static readonly inject = [OfficeAuth] as const;

  readonly #auth: OfficeAuth;

  constructor(auth: OfficeAuth) {
    super();
    this.#auth = auth;
  }

  async handle() {
    await this.#auth.signOut();
    return this.redirect().route('office.login');
  }
}
