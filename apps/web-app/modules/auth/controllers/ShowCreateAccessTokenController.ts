import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { abilityDescriptions } from '../abilities.ts';
import { LAYER } from './StoreAccessTokenController.ts';

/** The form for a new token — a layer over the list (`<Link route="auth.tokens.create" layer>`). */
export class ShowCreateAccessTokenController extends Controller {
  readonly #translator: Translator;

  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }

  handle(_ctx: HttpContext<Authenticated>) {
    return this.view('auth/CreateAccessToken', { abilities: abilityDescriptions(this.#translator) }).layer(LAYER);
  }
}
