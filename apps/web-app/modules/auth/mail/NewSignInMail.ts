import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

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
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.new_sign_in.subject', { app: this.#t.get('app.name') }) };
  }

  content() {
    const t = this.#t;
    const { at, ip, browser } = this.#signIn;
    // In UTC: a worker has no time zone of the user's.
    const when = t.format.date(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
    return layout(t, {
      preview: t.get('auth.mail.new_sign_in.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.new_sign_in.intro', { app: t.get('app.name') })}</mj-text>
        <mj-text>${t.get('auth.mail.new_sign_in.details', { at: `${when} UTC`, ip: ip ?? '—', browser: browser ?? '—' })}</mj-text>
        <mj-text>${t.get('auth.mail.new_sign_in.outro')}</mj-text>
        <mj-button href="${this.#url}">${t.get('auth.mail.new_sign_in.button')}</mj-button>`,
    });
  }
}
