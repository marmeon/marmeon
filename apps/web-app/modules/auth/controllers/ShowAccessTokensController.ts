import { AccessTokenStore, type Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';

/** The user's API tokens — behind confirmedPassword(): a token is as good as a session. */
export class ShowAccessTokensController extends Controller {
  readonly #tokens: AccessTokenStore;

  constructor(tokens: AccessTokenStore) {
    super();
    this.#tokens = tokens;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    // The plain text of a new token is never here: it is the answer of creating one, a layer shown once.
    return this.view('auth/AccessTokens', { tokens: await this.#tokens.list(ctx.user.id) });
  }
}
