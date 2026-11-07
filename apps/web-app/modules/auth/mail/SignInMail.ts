import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { SignInView } from './SignInView.tsx';
import type { User } from '../users.ts';

/** What happened to the account's sign-ins. */
export type SignInNotice = {
  readonly kind: 'remember_reused';
  readonly at: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly sessionsEnded: boolean;
};

/**
 * To the owner when an old or altered "keep me signed in" cookie of the account was sent. In the user's language. It shows a
 * parsed browser and system, never the raw `User-Agent` (the client writes that header), and says plainly that whoever holds a copy
 * may have sent it.
 */
export class SignInMail implements Mailable {
  readonly #user: User;
  readonly #notice: SignInNotice;
  readonly #t: Translator;

  constructor(user: User, notice: SignInNotice, t: Translator) {
    this.#user = user;
    this.#notice = notice;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/SignInMail`, development only). */
  static preview(context: MailPreviewContext): SignInMail {
    const { user, t } = previewData(context);
    return new SignInMail(user, { kind: 'remember_reused', at: new Date().toISOString(), ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/130.0', sessionsEnded: true }, t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get(`auth.mail.sign_in.${this.#notice.kind}.subject`) };
  }

  content() {
    return toMjml(SignInView, { t: this.#t, user: this.#user, notice: this.#notice });
  }
}
