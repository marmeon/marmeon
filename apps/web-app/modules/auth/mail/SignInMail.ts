import { describeDevice } from '@marmeon/auth';
import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';
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
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get(`auth.mail.sign_in.${this.#notice.kind}.subject`) };
  }

  content() {
    const t = this.#t;
    const { at, ip, userAgent, sessionsEnded } = this.#notice;
    const key = `auth.mail.sign_in.${this.#notice.kind}` as const;
    const { browser, system } = describeDevice(userAgent ?? undefined);
    // In UTC: a worker has no time zone of the user's.
    const when = `${t.format.date(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
    const device = browser && system ? t.get(`${key}.device`, { browser, system }) : (browser ?? system);
    // Only what is known is said, like the address of the failed second factor.
    const from = ip === null ? '' : t.get(`${key}.from`, { ip });
    const using = device === undefined ? '' : t.get(`${key}.with`, { device });
    return layout(t, {
      preview: t.get(`${key}.preview`),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get(`${key}.intro`)} ${t.get(sessionsEnded ? `${key}.ended` : `${key}.not_ended`)}</mj-text>
        <mj-text>${t.get(`${key}.details`, { at: when, from, with: using })}</mj-text>
        <mj-text>${t.get(sessionsEnded ? `${key}.outro` : `${key}.outro_not_ended`)}</mj-text>`,
    });
  }
}
