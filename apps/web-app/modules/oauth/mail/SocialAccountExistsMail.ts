import type { Translator } from '@marmeon/i18n';
import type { Mailable } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { SocialAccountExistsView } from './SocialAccountExistsView.tsx';

/**
 * Sent to the owner of an address when somebody signed in at a provider with it and the provider did not verify it. Nothing was linked and
 * nobody was signed in. It names no person: the address is unconfirmed text of the provider, and the account's name is not the sender's to read.
 */
export class SocialAccountExistsMail implements Mailable {
  readonly #email: string;
  readonly #provider: string;
  readonly #login: string;
  readonly #appName: string;
  readonly #t: Translator;

  constructor(email: string, provider: string, login: string, appName: string, t: Translator) {
    this.#email = email;
    this.#provider = provider;
    this.#login = login;
    this.#appName = appName;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#email }, subject: this.#t.get('oauth.mail.exists.subject') };
  }

  content() {
    return toMjml(SocialAccountExistsView, { t: this.#t, provider: this.#provider, login: this.#login, appName: this.#appName });
  }
}
