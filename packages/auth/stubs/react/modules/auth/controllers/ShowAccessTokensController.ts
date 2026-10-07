import { AccessTokenStore, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { abilityDescriptions } from '../abilities.ts';

/** The user's API tokens — behind confirmedPassword(): a token is as good as a session. */
export class ShowAccessTokensController extends Controller {
  readonly #tokens: AccessTokenStore;
  readonly #translator: Translator;

  constructor(tokens: AccessTokenStore, translator: Translator) {
    super();
    this.#tokens = tokens;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    return this.view('auth/AccessTokens', {
      tokens: await this.#tokens.list(ctx.user.id),
      abilities: abilityDescriptions(this.#translator),
      // Only in the answer to "create" — never stored, never shown again.
      plainText: null as string | null,
    });
  }
}
