import { AccessTokenStore, type Authenticated } from '@marmeon/auth';
import { Translator } from '@marmeon/i18n';
import { abort, Controller, type HttpContext } from '@marmeon/http';

/**
 * Revoking a token — an action (E59, `useAction('auth.tokens.destroy')`): the list drops it at once (optimistic), the answer
 * says which one went. Typed: the view's `result.data.revoked` is a number.
 */
export class RevokeAccessTokenController extends Controller {
  readonly #tokens: AccessTokenStore;
  readonly #translator: Translator;

  constructor(tokens: AccessTokenStore, translator: Translator) {
    super();
    this.#tokens = tokens;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated, { token: string }>) {
    // Only the user's own: someone else's token id is a 404, like one that does not exist.
    const id = /^\d{1,15}$/.test(ctx.params.token) ? Number(ctx.params.token) : 0;
    if (!(await this.#tokens.revoke(ctx.user.id, id))) abort(404);
    // The answer brings its toast (E60): `useAction` gets it with the data — it fires once, nothing waits in the session.
    return this.json({ revoked: id }).flash('toast', { kind: 'success', message: this.#translator.get('auth.tokens.revoked') });
  }
}
