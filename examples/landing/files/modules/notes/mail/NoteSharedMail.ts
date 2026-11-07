import { Translators, type Translator } from '@marmeon/i18n';
import type { Address, Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { NoteSharedView } from './NoteSharedView.tsx';

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
    return toMjml(NoteSharedView, { t: this.#t, title: this.#title });
  }
}
