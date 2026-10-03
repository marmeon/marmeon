import type { Translator } from '@bespokecore/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@bespokecore/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

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

  /** The preview (`/_bespoke/mail/auth/WelcomeMail`, development only). */
  static preview(context: MailPreviewContext): WelcomeMail {
    const { user, url, t } = previewData(context);
    return new WelcomeMail(user, url('/users/me'), t);
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.welcome.subject', { app: this.#t.get('app.name') }) };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.welcome.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.welcome.intro', { app: t.get('app.name') })}</mj-text>
        <mj-button href="${this.#url}">${t.get('auth.mail.welcome.button')}</mj-button>
        <mj-text>${t.get('auth.mail.welcome.outro')}</mj-text>`,
    });
  }
}
