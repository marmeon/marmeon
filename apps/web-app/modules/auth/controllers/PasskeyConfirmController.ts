import { Passkeys, type AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const PasskeyConfirmRequest = defineRequest({
  schema: r.object({
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'auth.passkeys.failed')),
  }),
});

/**
 * Confirms sudo mode with a passkey instead of the password, and goes back to the page that asked for it. The throttle, the event and the
 * check against the stored passkey live in `Passkeys`; a wrong response leaves the page where it is, with one message for every failure.
 * One of these requests per session at a time (block()).
 */
export class PasskeyConfirmController extends Controller {
  static request = PasskeyConfirmRequest;

  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof PasskeyConfirmRequest>) {
    const done = await this.#passkeys.confirm(ctx.body.response);
    if (done.ok) return this.redirect().intended().route('auth.security');
    if (done.error.kind === 'throttled') return this.json({ error: this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfterSeconds }) }, { status: 429 });
    // No challenge, an expired one, a wrong answer: the client learns only that it did not work.
    return this.json({ error: this.#translator.get('auth.passkeys.failed') }, { status: 422 });
  }
}
