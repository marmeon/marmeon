import { AccessTokenStore, type Authenticated } from '@bespokecore/auth';
import { abort, Controller, type HttpContext } from '@bespokecore/http';

/**
 * Revoking a token — an action (E59, `useAction('auth.tokens.destroy')`): the list drops it at once (optimistic), the answer
 * says which one went. Typed: the view's `result.data.revoked` is a number.
 */
export class RevokeAccessTokenController extends Controller {
  readonly #tokens: AccessTokenStore;

  constructor(tokens: AccessTokenStore) {
    super();
    this.#tokens = tokens;
  }

  async handle(ctx: HttpContext<Authenticated, { token: string }>) {
    // Only the user's own: someone else's token id is a 404, like one that does not exist.
    const id = /^\d{1,15}$/.test(ctx.params.token) ? Number(ctx.params.token) : 0;
    if (!(await this.#tokens.revoke(ctx.user.id, id))) abort(404);
    return this.json({ revoked: id });
  }
}
