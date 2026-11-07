import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { TwoFactorView } from './TwoFactorView.tsx';
import type { User } from '../users.ts';

/** What happened to the account's second factor. */
export type TwoFactorNotice =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'authenticator_removed' }
  | { readonly kind: 'disabled_by_operator' }
  | { readonly kind: 'disabled_by_reset' }
  | { readonly kind: 'recovery_used'; readonly remaining: number }
  | { readonly kind: 'failed'; readonly at: string; readonly ip: string | null };

/** To the owner when the second factor changes or is put to the test — if it was not you, you learn about it. In the user's language. */
export class TwoFactorMail implements Mailable {
  readonly #user: User;
  readonly #notice: TwoFactorNotice;
  readonly #t: Translator;

  constructor(user: User, notice: TwoFactorNotice, t: Translator) {
    this.#user = user;
    this.#notice = notice;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/TwoFactorMail`, development only): someone knew the password. */
  static preview(context: MailPreviewContext): TwoFactorMail {
    const { user, t } = previewData(context);
    return new TwoFactorMail(user, { kind: 'failed', at: new Date().toISOString(), ip: '203.0.113.7' }, t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get(`auth.mail.two_factor.${this.#notice.kind}.subject`) };
  }

  content() {
    return toMjml(TwoFactorView, { t: this.#t, user: this.#user, notice: this.#notice });
  }
}
