import type { RegistrationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficePasskeys } from './guard.ts';
import { passwordMessage } from './password-message.ts';

export const RegisterPasskeyRequest = defineRequest({
  schema: r.object({
    response: r.value<RegistrationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'office.passkeys.registerFailed')),
    name: r.string().trim().max(100).default(''),
    // Every passkey asks for the password: a passkey outlives a password change, so a stolen session must not be able to add one.
    password: r.string().required().max(4096),
  }),
});

/** Adds the passkey the browser made. The first passkey is the editor's first factor: the other sign-ins end and the answer holds the recovery codes, shown once. */
export class RegisterOfficePasskeyController extends Controller {
  static request = RegisterPasskeyRequest;
  static readonly inject = [OfficePasskeys, Translator] as const;

  readonly #passkeys: OfficePasskeys;
  readonly #translator: Translator;

  constructor(passkeys: OfficePasskeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegisterPasskeyRequest>) {
    const done = await this.#passkeys.register(ctx.body.response, ctx.body.name, ctx.body.password);
    if (done.ok) return this.json({ recoveryCodes: done.value.recoveryCodes });
    switch (done.error.kind) {
      case 'invalid-password':
        return this.json({ field: 'password', error: passwordMessage(this.#translator, done.error) }, { status: 422 });
      case 'throttled':
        return this.json({ field: 'password', error: passwordMessage(this.#translator, done.error) }, { status: 429 });
      case 'signed-out':
        // The session ended meanwhile and nothing was stored: the page's next request lands on the sign-in.
        return this.json({ error: this.#translator.get('office.passkeys.registerFailed') }, { status: 401 });
      case 'limit':
        return this.json({ error: this.#translator.get('office.passkeys.limit') }, { status: 422 });
      default:
        return this.json({ error: this.#translator.get('office.passkeys.registerFailed') }, { status: 422 });
    }
  }
}
