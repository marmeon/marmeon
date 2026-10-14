import { Auth, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';

/**
 * Signs the user out of one of their other browsers (the list on the security page). Behind confirmedPassword(): a stolen session
 * must not end its owner's others.
 */
export class EndSignInController extends Controller {
  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated, { signIn: string }>) {
    const ended = await this.#auth.endSignIn(ctx.params.signIn);
    // An id that is gone and one that is somebody else's get the same answer: it tells nothing about other accounts.
    const current = !ended.ok && ended.error.kind === 'current';
    const message =
      current
        ? this.#translator.get('auth.security.sign_ins_use_logout')
        : this.#translator.get('auth.security.sign_ins_ended');
    return this.back('/settings/security').flash('toast', { kind: current ? 'info' : 'success', message });
  }
}
