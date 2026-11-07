import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { WelcomeView } from './WelcomeView.tsx';

/** After registration, from the queue: hello, and where to start — in the user's language. */
export class WelcomeMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #t: Translator;

  constructor(user: User, url: string, t: Translator) {
    this.#user = user;
    this.#url = url;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/WelcomeMail`, development only). */
  static preview(context: MailPreviewContext): WelcomeMail {
    const { user, url, t } = previewData(context);
    return new WelcomeMail(user, url('/users/me'), t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get('auth.mail.welcome.subject', { app: this.#t.get('app.name') }) };
  }

  content() {
    return toMjml(WelcomeView, { t: this.#t, user: this.#user, url: this.#url });
  }
}
