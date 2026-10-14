import { Auth, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';

/** Signs the user out of one of their other browsers — behind confirmedPassword(): a stolen session must not end its owner's others. */
export class EndSignInController extends Controller {
  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated, { signIn: string }>) {
    // Only the user's own sign-ins can be ended: another account's id, an unknown one and one that is already gone get the same answer.
    const ended = await this.#auth.endSignIn(ctx.params.signIn);
    // Ended, gone or somebody else's: one answer, which tells nothing about other accounts.
    const refused = !ended.ok && ended.error.kind === 'current';
    return this.back('/settings/security').flash('toast', {
      kind: refused ? 'info' : 'success',
      message: this.#translator.get(refused ? 'auth.security.sign_ins_use_logout' : 'auth.security.sign_ins_ended'),
    });
  }
}
