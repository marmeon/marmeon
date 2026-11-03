import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import { confirmedName, greeting, recipient } from './greeting.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';
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
    const t = this.#t;
    const notice = this.#notice;
    const key = `auth.mail.passkey.${notice.kind}` as const;
    // A passkey's name is its holder's own text and can be changed while the address is unconfirmed: to such an address no name goes out
    // (`confirmedName`), neither in the intro nor in the list.
    const named = confirmedName(this.#user) !== null;
    // Only what the kind has to say is passed on; the others ignore the values. Names are the user's own text: mjml escapes them.
    const values = {
      name: named && (notice.kind === 'added' || notice.kind === 'suspended') ? (notice.name ?? '') : '',
      from: notice.kind === 'sign_in_failed' && notice.ip !== null ? t.get('auth.mail.passkey.sign_in_failed.from', { ip: notice.ip }) : '',
    };
    // A suspended passkey that is gone by now has no name to give.
    const unnamed = !named && (notice.kind === 'added' || notice.kind === 'suspended' || notice.kind === 'after_reset');
    const intro = unnamed || (notice.kind === 'suspended' && notice.name === null) ? t.get(`auth.mail.passkey.${notice.kind}.intro_unnamed` as 'auth.mail.passkey.suspended.intro_unnamed') : t.get(`${key}.intro`, values);
    return layout(t, {
      preview: t.get(`${key}.preview`),
      body: mjml`
        <mj-text>${greeting(t, confirmedName(this.#user))}</mj-text>
        <mj-text>${intro}</mj-text>
        ${notice.kind === 'after_reset' && named ? mjml`<mj-text><ul>${notice.names.map((name) => mjml`<li>${name}</li>`)}</ul></mj-text>` : ''}
        <mj-text>${t.get(`${key}.outro`)}</mj-text>`,
    });
  }
}
