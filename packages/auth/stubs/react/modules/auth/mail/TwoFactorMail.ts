import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';
import type { User } from '../users.ts';

/** What happened to the account's second factor. */
export type TwoFactorNotice =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'disabled_by_operator' }
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
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get(`auth.mail.two_factor.${this.#notice.kind}.subject`) };
  }

  content() {
    const t = this.#t;
    const notice = this.#notice;
    const key = `auth.mail.two_factor.${notice.kind}` as const;
    // Only what the kind has to say is passed on; the others ignore the values.
    const values = { remaining: notice.kind === 'recovery_used' ? notice.remaining : 0, at: notice.kind === 'failed' ? `${notice.at.slice(0, 16).replace('T', ' ')} UTC` : '', from: notice.kind === 'failed' && notice.ip !== null ? t.get('auth.mail.two_factor.failed.from', { ip: notice.ip }) : '' };
    return layout(t, {
      preview: t.get(`${key}.preview`),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get(`${key}.intro`, values)}</mj-text>
        <mj-text>${t.get(`${key}.outro`)}</mj-text>`,
    });
  }
}
