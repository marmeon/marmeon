import { Controller } from '@marmeon/http';
import { SocialAccounts } from '@marmeon/oauth/accounts';

/**
 * The buttons that confirm with a provider: one per linked account whose provider can prove a fresh sign-in. An island, placed on the
 * confirmation page of your app, beside the password form.
 */
export class ShowConfirmButtonsController extends Controller {
  readonly #accounts: SocialAccounts;

  constructor(accounts: SocialAccounts) {
    super();
    this.#accounts = accounts;
  }

  async handle() {
    const accounts = await this.#accounts.list();
    return this.island('oauth/ConfirmButtons', { providers: accounts.filter((account) => account.canConfirm).map(({ provider, label }) => ({ name: provider, label })) });
  }
}
