import { mjml, type Mailable } from '@bespokecore/mail';
import { layout } from './layout.ts';

/** To the old address when the address changes — if it was not you, you learn about it. */
export class EmailChangedMail implements Mailable {
  readonly #name: string;
  readonly #oldEmail: string;
  readonly #newEmail: string;

  constructor(name: string, oldEmail: string, newEmail: string) {
    this.#name = name;
    this.#oldEmail = oldEmail;
    this.#newEmail = newEmail;
  }

  envelope() {
    return { to: { address: this.#oldEmail, name: this.#name }, subject: 'Your e-mail address was changed' };
  }

  content() {
    return layout({
      preview: 'The address of your account changed',
      body: mjml`
        <mj-text>Hello ${this.#name},</mj-text>
        <mj-text>the e-mail address of your account was changed to ${this.#newEmail}.</mj-text>
        <mj-text>If that was not you, reset your password now and contact us.</mj-text>`,
    });
  }
}
