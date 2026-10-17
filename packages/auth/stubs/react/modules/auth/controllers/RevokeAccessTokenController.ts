import { AccessTokenStore, type Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';

export class RevokeAccessTokenController extends Controller {
  readonly #tokens: AccessTokenStore;
  readonly #translator: Translator;

  constructor(tokens: AccessTokenStore, translator: Translator) {
    super();
    this.#tokens = tokens;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated, { token: string }>) {
    // Only the user's own: someone else's token id is a 404, like one that does not exist. The kit's keys are numbers; anything that
    // is not one is no id of ours and costs no query (Postgres would refuse a UUID for a number key with a 500). An app with
    // UUID keys matches its own pattern here and passes the string on: `revoke` takes both.
    const id = /^\d{1,15}$/.test(ctx.params.token) ? Number(ctx.params.token) : undefined;
    if (id === undefined || !(await this.#tokens.revoke(ctx.user.id, id))) abort(404);
    return this.redirect().route('auth.tokens').flash('toast', { kind: 'success', message: this.#translator.get('auth.tokens.revoked') });
  }
}
