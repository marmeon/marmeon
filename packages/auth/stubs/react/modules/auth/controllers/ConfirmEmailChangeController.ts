import { type Authenticated, EmailChange } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { UserRepository } from '../UserRepository.ts';
import { HOME } from '../home.ts';

/**
 * The link from ConfirmNewEmailMail (private registration) — behind authenticate() and signed(): made by the app and unexpired.
 * `EmailChange.confirm()` uses it up once, for the signed-in account it names; this controller only writes the address
 * (`UserRepository.applyEmailChange`) and words the failures. The old address is told by the `EmailChanged` listener.
 */
export class ConfirmEmailChangeController extends Controller {
  readonly #emailChange: EmailChange;
  readonly #users: UserRepository;
  readonly #translator: Translator;

  constructor(emailChange: EmailChange, users: UserRepository, translator: Translator) {
    super();
    this.#emailChange = emailChange;
    this.#users = users;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated, { id: string; token: string }>) {
    const changed = await this.#emailChange.confirm(ctx.params.id, ctx.params.token, (id, email, at) => this.#users.applyEmailChange(id, email, at));
    if (!changed.ok) {
      // A valid signature proves the app made the link — not that it is yours.
      if (changed.error.kind === 'not-found') abort(404);
      if (changed.error.kind === 'wrong-account') abort(403, this.#translator.get('auth.email_change.wrong_account'));
      if (changed.error.kind === 'invalid') abort(403, this.#translator.get('auth.email_change.invalid'));
      // Registered (or changed to) by another account since: the unique index decided, the link is used up.
      abort(409, this.#translator.get('auth.email_change.taken'));
    }
    return this.redirect().route(HOME).flash('toast', { kind: 'success', message: this.#translator.get('auth.email_change.done', { email: changed.value.email }) });
  }
}
