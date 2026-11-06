import type { Translator } from '@marmeon/i18n';
import { mjml, type Address, type Mailable } from '@marmeon/mail';

/** Tells somebody that a note was shared with them, in their language. */
export class NoteSharedMail implements Mailable {
  readonly #to: Address;
  readonly #title: string;
  readonly #t: Translator;

  constructor(to: Address, title: string, t: Translator) {
    this.#to = to;
    this.#title = title;
    this.#t = t;
  }

  envelope() {
    return { to: this.#to, subject: this.#t.get('notes.mail.shared.subject') };
  }

  content() {
    const text = this.#t.get('notes.mail.shared.intro', { title: this.#title });
    return mjml`<mjml><mj-body><mj-section><mj-column><mj-text>${text}</mj-text></mj-column></mj-section></mj-body></mjml>`;
  }
}
