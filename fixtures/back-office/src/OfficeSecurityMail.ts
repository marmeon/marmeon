import type { Translator } from '@marmeon/i18n';
import { html, type Mailable } from '@marmeon/mail';

/** What happened to an editor's sign-ins or second factors. */
export type OfficeSecurityNotice =
  | { readonly kind: 'signedIn'; readonly at: string }
  | { readonly kind: 'twoFactorEnabled' }
  | { readonly kind: 'twoFactorDisabled' }
  | { readonly kind: 'authenticatorRemoved' }
  | { readonly kind: 'twoFactorDisabledByOperator' }
  | { readonly kind: 'twoFactorDisabledByReset' }
  | { readonly kind: 'passkeyAdded' };

/**
 * To the editor's own address, the one in `office_users`, when a sign-in happens or a second factor changes: if it was not them, they learn about it.
 * Invariant: the editor's name, which whoever invited them chose, goes through the `html` tag, which escapes it; no value of a request reaches the text
 * except the time of the sign-in, which the server wrote.
 */
export class OfficeSecurityMail implements Mailable {
  readonly #editor: { readonly name: string; readonly email: string };
  readonly #notice: OfficeSecurityNotice;
  readonly #t: Translator;

  constructor(editor: { readonly name: string; readonly email: string }, notice: OfficeSecurityNotice, t: Translator) {
    this.#editor = editor;
    this.#notice = notice;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#editor.email, name: this.#editor.name }, subject: this.#t.get(`office.mail.${this.#notice.kind}.subject`) };
  }

  content() {
    const body = this.#notice.kind === 'signedIn' ? this.#t.get('office.mail.signedIn.body', { at: this.#notice.at }) : this.#t.get(`office.mail.${this.#notice.kind}.body`);
    return html`<p>${this.#t.get('office.mail.hello', { name: this.#editor.name })}</p><p>${body}</p><p>${this.#t.get('office.mail.ignore')}</p>`;
  }
}
