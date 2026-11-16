import type { AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeAuth, OfficeTwoFactor } from './guard.ts';

export const PasskeyChallengeRequest = defineRequest({
  schema: r.object({
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'office.challenge.failed')),
  }),
});

/**
 * Finishes the sign-in with a passkey of the editor who typed the password. The count of wrong factors, the throttle and the check against the stored
 * passkey live in the guard's `TwoFactor` and `Passkeys`; this maps their answers. One request per session at a time (`block()`).
 */
export class OfficePasskeyChallengeController extends Controller {
  static request = PasskeyChallengeRequest;
  static readonly inject = [OfficeTwoFactor, OfficeAuth, Translator] as const;

  readonly #twoFactor: OfficeTwoFactor;
  readonly #auth: OfficeAuth;
  readonly #translator: Translator;

  constructor(twoFactor: OfficeTwoFactor, auth: OfficeAuth, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof PasskeyChallengeRequest>) {
    const done = await this.#twoFactor.challenge({ passkey: ctx.body.response });
    if (done.ok) {
      if (this.#auth.passwordCheckScope().typed) {
        const device = await this.#auth.deviceCookie();
        if (device) ctx.cookies.set(device.name, device.value, device.options);
      }
      return this.redirect().intended().route('office.index');
    }
    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        return this.json({ error: this.#translator.get('office.challenge.expired'), login: true }, { status: 422 });
      case 'throttled':
        return this.json({ error: this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds }) }, { status: 429 });
      case 'invalid-code':
        // The last wrong try ended the wait: the password is typed again.
        if (done.error.attemptsLeft === 0) return this.json({ error: this.#translator.get('office.challenge.locked'), login: true }, { status: 422 });
        return this.json({ error: this.#translator.get('office.challenge.failed') }, { status: 422 });
    }
  }
}
