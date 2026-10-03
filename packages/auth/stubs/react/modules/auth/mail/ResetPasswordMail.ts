import type { Translator } from '@bespokecore/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@bespokecore/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

/**
 * The "forgot password" link — composed and queued by a job (SendPasswordResetLinkJob), so the answer does not tell
 * whether the address has an account. In the recipient's language (`t`): the account's, whoever asked for the link.
 */
export class ResetPasswordMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #minutes: number;
  readonly #t: Translator;

  constructor(user: User, url: string, minutes: number, t: Translator) {
    this.#user = user;
    this.#url = url;
    this.#minutes = minutes;
    this.#t = t;
  }

  /** The preview (`/_bespoke/mail/auth/ResetPasswordMail`, development only). */
  static preview(context: MailPreviewContext): ResetPasswordMail {
    const { user, url, t } = previewData(context);
    return new ResetPasswordMail(user, url('/reset-password?token=preview&email=ada%40example.com'), 60, t);
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.reset.subject') };
  }

  content() {
    const t = this.#t;
    // Texts and values are escaped by mjml`…` — a name like "<b>" arrives as text.
    return layout(t, {
      preview: t.get('auth.mail.reset.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.reset.intro')}</mj-text>
        <mj-button href="${this.#url}">${t.get('auth.mail.reset.button')}</mj-button>
        <mj-text>${t.get('auth.mail.reset.outro', { minutes: this.#minutes })}</mj-text>`,
    });
  }
}
