import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { PasskeyView } from './PasskeyView.tsx';
import type { User } from '../users.ts';

/** What happened to the account's passkeys. */
export type PasskeyNotice =
  | { readonly kind: 'added'; readonly name: string }
  | { readonly kind: 'removed' }
  | { readonly kind: 'suspended'; readonly name: string | null }
  | { readonly kind: 'after_reset'; readonly names: readonly string[] }
  | { readonly kind: 'sign_in_failed'; readonly ip: string | null };

/**
 * To the owner when a passkey comes, goes or is suspended, when a password reset leaves passkeys that still sign in, and when a
 * passkey sign-in failed — if it was not you, you learn about it. In the user's language.
 */
export class PasskeyMail implements Mailable {
  readonly #user: User;
  readonly #notice: PasskeyNotice;
  readonly #t: Translator;

  constructor(user: User, notice: PasskeyNotice, t: Translator) {
    this.#user = user;
    this.#notice = notice;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/PasskeyMail`, development only): a password reset that left two passkeys. */
  static preview(context: MailPreviewContext): PasskeyMail {
    const { user, t } = previewData(context);
    return new PasskeyMail(user, { kind: 'after_reset', names: ['MacBook', 'Phone'] }, t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get(`auth.mail.passkey.${this.#notice.kind}.subject`) };
  }

  content() {
    return toMjml(PasskeyView, { t: this.#t, user: this.#user, notice: this.#notice });
  }
}
