import { AccessTokenStore, type Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { TOKEN_ABILITIES } from '../abilities.ts';

/** The user's API tokens — behind confirmedPassword(): a token is as good as a session. */
export class ShowAccessTokensController extends Controller {
  readonly #tokens: AccessTokenStore;
  readonly #session: Session;

  constructor(tokens: AccessTokenStore, session: Session) {
    super();
    this.#tokens = tokens;
    this.#session = session;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    return this.view('auth/AccessTokens', {
      tokens: await this.#tokens.list(ctx.user.id),
      abilities: TOKEN_ABILITIES,
      // Only in the answer to "create" — never stored, never shown again.
      plainText: null as string | null,
      csrfToken: this.#session.token(),
    });
  }
}
