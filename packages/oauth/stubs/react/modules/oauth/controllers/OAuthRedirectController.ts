import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OAuth } from '@marmeon/oauth';
import { TARGETS } from '../targets.ts';

/** Starts a sign-in: opens the flow in the session and sends the browser to the provider. A POST, so no other site can open a flow in somebody's browser. */
export class OAuthRedirectController extends Controller {
  readonly #oauth: OAuth;
  readonly #translator: Translator;

  constructor(oauth: OAuth, translator: Translator) {
    super();
    this.#oauth = oauth;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    const started = await this.#oauth.redirect(ctx.params.provider, { intent: 'sign-in' });
    if (started.ok) return this.redirect(started.value.href);
    // An unknown or inactive provider is a path that does not exist.
    if (started.error.kind === 'unknown-provider') abort(404);
    return this.redirect().route(TARGETS.login).flash('toast', { kind: 'error', message: this.#translator.get('oauth.messages.unavailable') });
  }
}
