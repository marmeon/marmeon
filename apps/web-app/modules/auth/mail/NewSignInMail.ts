import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { NewSignInView } from './NewSignInView.tsx';

/** What the mail says about a sign-in. */
export interface SignIn {
  readonly at: string;
  readonly ip: string | null;
  readonly browser: string | null;
}

/** "A new sign-in to your account" — from the NewSignInNotification, in the user's language. */
export class NewSignInMail implements Mailable {
  readonly #user: User;
  readonly #signIn: SignIn;
  readonly #url: string;
  readonly #t: Translator;

  constructor(user: User, signIn: SignIn, url: string, t: Translator) {
    this.#user = user;
    this.#signIn = signIn;
    this.#url = url;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/NewSignInMail`, development only). */
  static preview(context: MailPreviewContext): NewSignInMail {
    const { user, url, t } = previewData(context);
    return new NewSignInMail(user, { at: new Date().toISOString(), ip: '203.0.113.7', browser: 'Firefox · macOS' }, url('/settings/security'), t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get('auth.mail.new_sign_in.subject', { app: this.#t.get('app.name') }) };
  }

  content() {
    return toMjml(NewSignInView, { t: this.#t, user: this.#user, signIn: this.#signIn, url: this.#url });
  }
}
