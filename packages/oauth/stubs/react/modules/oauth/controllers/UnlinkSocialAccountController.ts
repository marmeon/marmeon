import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { SocialAccounts } from '@marmeon/oauth/accounts';
import { Router } from '@marmeon/router';
import { TARGETS } from '../targets.ts';

/**
 * Removes the signed-in user's account at a provider. `SocialAccounts.unlink()` decides: it needs a recent confirmation, and it refuses
 * to remove the last way in (a password, a passkey or an account at another active provider).
 */
export class UnlinkSocialAccountController extends Controller {
  readonly #accounts: SocialAccounts;
  readonly #translator: Translator;
  readonly #router: Router;

  constructor(accounts: SocialAccounts, translator: Translator, router: Router) {
    super();
    this.#accounts = accounts;
    this.#translator = translator;
    this.#router = router;
  }

  async handle(ctx: HttpContext<Authenticated, { provider: string }>) {
    const removed = await this.#accounts.unlink(ctx.params.provider);
    if (removed.ok) return this.#back('success', 'unlinked');
    switch (removed.error.kind) {
      case 'signed-out':
        return this.redirect().route(TARGETS.login).flash('toast', { kind: 'error', message: this.#translator.get('oauth.messages.session_ended') });
      case 'confirmation-required':
        return this.#back('error', 'unlink_confirm_first');
      case 'not-found':
        return this.#back('error', 'unlink_not_found');
      case 'last-method':
        return this.#back('error', 'last_method');
    }
  }

  #back(kind: 'success' | 'error', notice: 'unlinked' | 'unlink_confirm_first' | 'unlink_not_found' | 'last_method') {
    return this.back(this.#router.url(TARGETS.home)).flash('toast', { kind, message: this.#translator.get(`oauth.messages.${notice}`) });
  }
}
