import { Translators, type Translator } from '@marmeon/i18n';
import { mjml, type Address, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import { layout } from './layout.ts';

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

  /** The preview (`/_marmeon/mail/notes/NoteSharedMail`, development only), with sample data: nothing is stored. */
  static preview({ make, locale }: MailPreviewContext): NoteSharedMail {
    return new NoteSharedMail({ address: 'ada@example.com', name: 'Ada Lovelace' }, 'Groceries', make(Translators).for(locale));
  }

  envelope() {
    return { to: this.#to, subject: this.#t.get('notes.mail.shared.subject') };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('notes.mail.shared.subject'),
      body: mjml`
        <mj-text>${t.get('notes.mail.shared.intro', { title: this.#title })}</mj-text>`,
    });
  }
}
