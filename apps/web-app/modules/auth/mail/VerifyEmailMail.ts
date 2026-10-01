import type { Translator } from '@bespokecore/i18n';
import { mjml, type Mailable } from '@bespokecore/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';

/** After registration and after a change of address: a signed link to confirm the address — in the user's language. */
export class VerifyEmailMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #t: Translator;

  constructor(user: User, url: string, t: Translator) {
    this.#user = user;
    this.#url = url;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.verify.subject') };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.verify.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.verify.intro')}</mj-text>
        <mj-button href="${this.#url}">${t.get('auth.mail.verify.button')}</mj-button>
        <mj-text>${t.get('auth.mail.verify.outro')}</mj-text>`,
    });
  }
}
