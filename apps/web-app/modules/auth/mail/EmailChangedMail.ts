import type { Translator } from '@bespokecore/i18n';
import { mjml, type Mailable } from '@bespokecore/mail';
import { layout } from './layout.ts';

/** To the old address when the address changes — if it was not you, you learn about it. In the user's language. */
export class EmailChangedMail implements Mailable {
  readonly #name: string;
  readonly #oldEmail: string;
  readonly #newEmail: string;
  readonly #t: Translator;

  constructor(name: string, oldEmail: string, newEmail: string, t: Translator) {
    this.#name = name;
    this.#oldEmail = oldEmail;
    this.#newEmail = newEmail;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#oldEmail, name: this.#name }, subject: this.#t.get('auth.mail.email_changed.subject') };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.email_changed.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#name })}</mj-text>
        <mj-text>${t.get('auth.mail.email_changed.intro', { email: this.#newEmail })}</mj-text>
        <mj-text>${t.get('auth.mail.email_changed.outro')}</mj-text>`,
    });
  }
}
