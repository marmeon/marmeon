import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import type { Talk } from '../TalkCatalog.ts';

/** `GET /talks/:talk`: the welcome in the talk's language (the route's `afterAuthorize` set it), else the visitor's. */
export class ShowTalkController extends Controller {
  readonly #translator: Translator;

  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }

  handle(ctx: HttpContext<{}, { talk: Talk }>) {
    return { locale: this.#translator.locale, welcome: this.#translator.get('app.talk.welcome', { title: ctx.params.talk.title }) };
  }
}
