import type { Translator } from '@marmeon/i18n';
import type { Mailable } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { SocialAccountLinkedView } from './SocialAccountLinkedView.tsx';

/**
 * Sent to the owner of an account when a provider account was connected to it, so that an owner who did not do it learns about it. It goes
 * only to an address the app has confirmed, and names no person: the provider's nickname or address is the only detail about the account.
 */
export class SocialAccountLinkedMail implements Mailable {
  readonly #email: string;
  readonly #provider: string;
  readonly #account: string | null;
  readonly #at: Date;
  readonly #appName: string;
  readonly #t: Translator;

  constructor(email: string, provider: string, account: string | null, at: Date, appName: string, t: Translator) {
    this.#email = email;
    this.#provider = provider;
    this.#account = account;
    this.#at = at;
    this.#appName = appName;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#email }, subject: this.#t.get('oauth.mail.linked.subject') };
  }

  content() {
    return toMjml(SocialAccountLinkedView, { t: this.#t, provider: this.#provider, account: this.#account, at: this.#at, appName: this.#appName });
  }
}
