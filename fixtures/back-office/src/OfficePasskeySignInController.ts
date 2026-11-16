import type { AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficePasskeys } from './guard.ts';

export const PasskeySignInRequest = defineRequest({
  schema: r.object({
    // The browser's answer, checked by the passkeys service; here only that it is an object.
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'office.challenge.failed')),
  }),
});

/**
 * Signs an editor in with a passkey alone: the whole sign-in, no second factor follows. A failure says nothing about why (an unknown passkey, a spent
 * challenge and a passkey of the app all answer alike). One request per session at a time (`block()`); the limit per address lives in `Passkeys`.
 */
export class OfficePasskeySignInController extends Controller {
  static request = PasskeySignInRequest;
  static readonly inject = [OfficePasskeys, Translator] as const;

  readonly #passkeys: OfficePasskeys;
  readonly #translator: Translator;

  constructor(passkeys: OfficePasskeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof PasskeySignInRequest>) {
    const done = await this.#passkeys.signIn(ctx.body.response);
    if (done.ok) return this.redirect().intended().route('office.index');
    if (done.error.kind === 'throttled') return this.json({ error: this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds }) }, { status: 429 });
    return this.json({ error: this.#translator.get('office.challenge.failed') }, { status: 422 });
  }
}
