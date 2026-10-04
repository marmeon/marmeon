import { Auth } from '@bespokecore/auth';
import { ClientHistory, Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { Locales, trans, Translator } from '@bespokecore/i18n';
import { Session } from '@bespokecore/session';
import * as v from 'valibot';
import { UserRepository } from '#modules/auth';

export const UpdateLocaleRequest = defineRequest({
  schema: v.object({ locale: v.pipe(v.string(trans('app.locale.unsupported')), v.maxLength(35)) }),
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
    // Every page the browser keeps — in memory, in its HTTP cache — is in the old language: a full load, and the
    // cache cleared (as after signing out — but not the site's storage: nobody signed out). The other tabs reload through
    // the tabSync feature: the session's epoch includes the locale.
    this.#history.clear({ siteData: ['cache'] });
    return this.back('/').flash('toast', { kind: 'success', message: this.#translator.forLocale(locale).get('app.locale.changed') });
  }
}
