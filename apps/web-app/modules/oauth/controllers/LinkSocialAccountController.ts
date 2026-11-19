import type { Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OAuth } from '@marmeon/oauth';
import { Router } from '@marmeon/router';
import { TARGETS } from '../targets.ts';

/**
 * Starts linking a provider account to the signed-in user: opens the flow in the session, for this user, and sends the browser to the
 * provider. A POST, so no other site can open a flow in somebody's browser. The confirmation that the link needs is checked when the flow
 * comes back, by `SocialAccounts.link()`.
 */
export class LinkSocialAccountController extends Controller {
  readonly #oauth: OAuth;
  readonly #translator: Translator;
  readonly #router: Router;

  constructor(oauth: OAuth, translator: Translator, router: Router) {
    super();
    this.#oauth = oauth;
    this.#translator = translator;
    this.#router = router;
  }

  async handle(ctx: HttpContext<Authenticated, { provider: string }>) {
    const started = await this.#oauth.redirect(ctx.params.provider, { intent: 'link', userId: ctx.user.id });
    if (started.ok) return this.redirect(started.value.href);
    // An unknown or inactive provider is a path that does not exist.
    if (started.error.kind === 'unknown-provider') abort(404);
    return this.back(this.#router.url(TARGETS.home)).flash('toast', { kind: 'error', message: this.#translator.get('oauth.messages.link_unavailable') });
  }
}
