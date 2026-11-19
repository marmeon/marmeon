import type { Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OAuth } from '@marmeon/oauth';
import { SocialAccounts } from '@marmeon/oauth/accounts';
import { Router } from '@marmeon/router';
import { TARGETS } from '../targets.ts';

/**
 * Starts a confirmation at a provider the signed-in user has linked: the person signs in there again, and the callback opens the
 * confirmation window. A provider that cannot prove a fresh sign-in is refused with the notice `confirm_unsupported`, and one the person has not linked with `confirm_not_linked`.
 */
export class ConfirmWithProviderController extends Controller {
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;
  readonly #translator: Translator;
  readonly #router: Router;

  constructor(oauth: OAuth, accounts: SocialAccounts, translator: Translator, router: Router) {
    super();
    this.#oauth = oauth;
    this.#accounts = accounts;
    this.#translator = translator;
    this.#router = router;
  }

  async handle(ctx: HttpContext<Authenticated, { provider: string }>) {
    // The id of the account is looked up from the user's links, never taken from the request.
    const account = await this.#accounts.accountId(ctx.params.provider);
    if (account === undefined) return this.#back('confirm_not_linked');
    const started = await this.#oauth.redirect(ctx.params.provider, { intent: 'confirm', userId: ctx.user.id, account });
    if (started.ok) return this.redirect(started.value.href);
    if (started.error.kind === 'unknown-provider') abort(404);
    return this.#back(started.error.kind === 'reauthentication-unsupported' ? 'confirm_unsupported' : 'confirm_unavailable');
  }

  #back(notice: 'confirm_not_linked' | 'confirm_unsupported' | 'confirm_unavailable') {
    return this.back(this.#router.url(TARGETS.home)).flash('toast', { kind: 'error', message: this.#translator.get(`oauth.messages.${notice}`) });
  }
}
