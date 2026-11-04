import { html, type Mailable } from '@marmeon/mail';
import type { User } from '#modules/auth';

/** The data of an account, to the address of the account. */
export class AccountExportMail implements Mailable {
  readonly #user: User;

  constructor(user: User) {
    this.#user = user;
  }

  envelope() {
    // The name is the registrant's own text: it goes only to an address the account has confirmed (as in the kit's mails).
    const { email, name, email_verified_at } = this.#user;
    return { to: email_verified_at === null ? { address: email } : { address: email, name }, subject: 'Your account data' };
  }

  content() {
    const { email } = this.#user;
    const name = this.#user.email_verified_at === null ? null : this.#user.name;
    const since = new Date(this.#user.created_at).toISOString().slice(0, 10);
    return html`<p>${name === null ? 'Hello,' : `Hello ${name},`}</p>
<p>This is the data we keep about your account:</p>
<ul>
  <li>Name: ${name ?? '—'}</li>
  <li>E-mail address: ${email}</li>
  <li>Account created: ${since}</li>
</ul>`;
  }
}
