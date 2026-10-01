import { Auth } from '@bespokecore/auth';
import { Controller } from '@bespokecore/http';
import { Translator } from '@bespokecore/i18n';
import { Session } from '@bespokecore/session';

export class LogoutController extends Controller {
  readonly #auth: Auth;

  readonly #session: Session;
  readonly #translator: Translator;

  constructor(auth: Auth, session: Session, translator: Translator) {
    super();
    this.#auth = auth;
    this.#session = session;
    this.#translator = translator;
  }

  async handle() {
    // The language chosen in this browser outlives the session it was stored in.
    const locale = this.#session.get('locale');
    await this.#auth.logout(); // new session id, new CSRF token, nothing of the old session left
    if (locale) this.#session.put('locale', locale);
    return this.redirect().route('auth.login').with('status', this.#translator.get('auth.status.signed_out'));
  }
}
