import { mjml, type Mailable } from '@bespokecore/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';

/** After registration and after a change of address: a signed link to confirm the address. */
export class VerifyEmailMail implements Mailable {
  readonly #user: User;
  readonly #url: string;

  constructor(user: User, url: string) {
    this.#user = user;
    this.#url = url;
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: 'Confirm your e-mail address' };
  }

  content() {
    return layout({
      preview: 'One click to confirm your address',
      body: mjml`
        <mj-text>Hello ${this.#user.name},</mj-text>
        <mj-text>please confirm that this address is yours.</mj-text>
        <mj-button href="${this.#url}">Confirm my e-mail address</mj-button>
        <mj-text>The link works for 60 minutes. If you did not create an account, ignore this mail.</mj-text>`,
    });
  }
}
