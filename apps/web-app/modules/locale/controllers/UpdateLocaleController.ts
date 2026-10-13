import { Auth } from '@marmeon/auth';
import { ClientHistory, Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Locales, Translator } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';

export const UpdateLocaleRequest = defineRequest({
  schema: r.object({ locale: r.string().max(35) }),
  messages: { 'locale.required': 'app.locale.unsupported', 'locale.string': 'app.locale.unsupported' },
});

/**
 * The language switcher: the choice goes into the session (it wins over the browser's languages) and, when signed
 * in, into the account — mails then reach the user in it, and other devices start in it.
 */
export class UpdateLocaleController extends Controller {
  static request = UpdateLocaleRequest;

  readonly #locales: Locales;
  readonly #session: Session;
  readonly #auth: Auth;
  readonly #users: UserRepository;
  readonly #history: ClientHistory;
  readonly #translator: Translator;

  constructor(locales: Locales, session: Session, auth: Auth, users: UserRepository, history: ClientHistory, translator: Translator) {
    super();
    this.#locales = locales;
    this.#session = session;
    this.#auth = auth;
    this.#users = users;
    this.#history = history;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdateLocaleRequest>) {
    // Only a supported locale, in its own spelling — never the posted value itself.
    const locale = this.#locales.find(ctx.body.locale);
    if (!locale) throw new ValidationError({ locale: ['app.locale.unsupported'] }, { locale: ctx.body.locale });

    this.#session.put('locale', locale);
    const user = await this.#auth.user();
    if (user) await this.#users.updateLocale(user.id, locale);
    // A full load drops the pages the client keeps in memory (old language). No cache clearing: guest pages carry no
    // freshness, so the browser asks again on a normal visit (Back/Forward may show a page in the old language until the
    // next visit), and "cache" makes Chrome scan its whole disk cache. The other tabs reload through the tabSync feature: the session's epoch includes the locale.
    this.#history.clear({ siteData: false });
    return this.back('/').flash('toast', { kind: 'success', message: this.#translator.forLocale(locale).get('app.locale.changed') });
  }
}
