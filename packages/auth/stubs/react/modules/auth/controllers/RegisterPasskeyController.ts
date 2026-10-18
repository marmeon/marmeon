import type { Authenticated } from '@marmeon/auth';
import { Passkeys, type RegistrationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { passwordCheckMessage } from '../password-errors.ts';

export const RegisterPasskeyRequest = defineRequest({
  schema: r.object({
    response: r.value<RegistrationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'auth.passkeys.failed')),
    name: r.string().trim().max(100).default(''),
    // Every passkey asks for the password: a passkey outlives a password change, so a stolen session must not be able to add one.
    password: r.string().required().max(4096),
  }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

/**
 * Adds the passkey the browser made. The first passkey is the account's first factor: the other devices are signed out and the answer
 * holds the recovery codes, shown once — they are in this answer only, never in the session.
 */
export class RegisterPasskeyController extends Controller {
  static request = RegisterPasskeyRequest;

  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegisterPasskeyRequest> & Authenticated) {
    const done = await this.#passkeys.register(ctx.body.response, ctx.body.name, ctx.body.password);
    if (done.ok) return this.json({ recoveryCodes: done.value.recoveryCodes });
    switch (done.error.kind) {
      case 'invalid-password':
        return this.json({ field: 'password', error: passwordCheckMessage(this.#translator, done.error) }, 422);
      case 'throttled':
        return this.json({ field: 'password', error: passwordCheckMessage(this.#translator, done.error) }, 429);
      case 'signed-out':
        // The session ended meanwhile and nothing was stored: the page's next request lands on the sign-in.
        return this.json({ error: this.#translator.get('auth.passkeys.register_failed') }, 401);
      case 'limit':
        return this.json({ error: this.#translator.get('auth.passkeys.limit') }, 422);
      default:
        return this.json({ error: this.#translator.get('auth.passkeys.register_failed') }, 422);
    }
  }
}
