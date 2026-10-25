import { Passkeys, type AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const PasskeySignInRequest = defineRequest({
  schema: r.object({
    // The browser's answer, checked by the passkeys service — here only that it is an object.
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'auth.passkeys.failed')),
    remember: r.boolean().default(false),
  }),
});

/**
 * Signs in with a passkey alone — the whole sign-in, no second factor follows. A failure says nothing about why (an unknown passkey,
 * a spent challenge, a missing verification all answer alike). One of these requests per session at a time (block()). The throttle per
 * address lives in `Passkeys`.
 */
export class PasskeySignInController extends Controller {
  static request = PasskeySignInRequest;

  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof PasskeySignInRequest>) {
    const done = await this.#passkeys.signIn(ctx.body.response, { remember: ctx.body.remember });
    if (done.ok) return this.redirect().intended().route('user-profile.me');
    if (done.error.kind === 'throttled') return this.json({ error: this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfterSeconds }) }, { status: 429 });
    return this.json({ error: this.#translator.get('auth.passkeys.failed') }, { status: 422 });
  }
}
