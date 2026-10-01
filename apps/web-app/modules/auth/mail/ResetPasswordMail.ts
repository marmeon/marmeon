import type { Translator } from '@bespokecore/i18n';
import { mjml, type Mailable } from '@bespokecore/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';

/**
 * The "forgot password" link. Sent after the response, so the answer does not tell whether the address has an account.
 * In the recipient's language (`t`): the account's, whoever asked for the link.
 */
export class ResetPasswordMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #minutes: number;
  readonly #t: Translator;

  constructor(user: User, url: string, minutes: number, t: Translator) {
    this.#user = user;
    this.#url = url;
    this.#minutes = minutes;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.reset.subject') };
  }

  content() {
    const t = this.#t;
    // Texts and values are escaped by mjml`…` — a name like "<b>" arrives as text.
    return layout(t, {
      preview: t.get('auth.mail.reset.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.reset.intro')}</mj-text>
        <mj-button href="${this.#url}">${t.get('auth.mail.reset.button')}</mj-button>
        <mj-text>${t.get('auth.mail.reset.outro', { minutes: this.#minutes })}</mj-text>`,
    });
  }
}
