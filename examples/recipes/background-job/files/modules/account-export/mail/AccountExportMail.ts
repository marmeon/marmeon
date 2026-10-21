import { html, type Mailable } from '@marmeon/mail';
import type { User } from '#modules/auth';

/** The data of an account, to the address of the account. */
export class AccountExportMail implements Mailable {
  readonly #user: User;

  constructor(user: User) {
    this.#user = user;
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: 'Your account data' };
  }

  content() {
    const { name, email } = this.#user;
    const since = new Date(this.#user.created_at).toISOString().slice(0, 10);
    return html`<p>Hello ${name},</p>
<p>This is the data we keep about your account:</p>
<ul>
  <li>Name: ${name}</li>
  <li>E-mail address: ${email}</li>
  <li>Account created: ${since}</li>
</ul>`;
  }
}
