import { mjml, type Mailable } from '@bespokecore/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';

/** The "forgot password" link. Sent after the response, so the answer does not tell whether the address has an account. */
export class ResetPasswordMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #minutes: number;

  constructor(user: User, url: string, minutes: number) {
    this.#user = user;
    this.#url = url;
    this.#minutes = minutes;
  }

  envelope() {
    return { to: { address: this.#user.email, name: this.#user.name }, subject: 'Reset your password' };
  }

  content() {
    return layout({
      preview: 'A link to choose a new password',
      body: mjml`
        <mj-text>Hello ${this.#user.name},</mj-text>
        <mj-text>someone — hopefully you — asked to reset the password of your account.</mj-text>
        <mj-button href="${this.#url}">Choose a new password</mj-button>
        <mj-text>The link works once, for ${this.#minutes} minutes. If you did not ask for it, ignore this mail: your password stays as it is.</mj-text>`,
    });
  }
}
