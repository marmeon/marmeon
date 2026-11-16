import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeAuth, OfficeTwoFactor } from './guard.ts';

export const TwoFactorChallengeRequest = defineRequest({
  // A code from the authenticator app, or a recovery code: whichever the form sent.
  schema: r.object({ code: r.string().trim().max(32).default(''), recovery_code: r.string().trim().max(64).default('') }),
});

/**
 * Finishes the sign-in with the second factor. The throttle (per editor, before the code is looked at) and the count of wrong codes live in the guard's
 * `TwoFactor`; this maps its answers to the page. One request per session at a time (`block()`).
 */
export class OfficeTwoFactorChallengeController extends Controller {
  static request = TwoFactorChallengeRequest;
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

  async handle(ctx: ContextOf<typeof TwoFactorChallengeRequest>) {
    const { code, recovery_code: recoveryCode } = ctx.body;
    const field = recoveryCode !== '' ? 'recovery_code' : 'code';
    const done = await this.#twoFactor.challenge(recoveryCode !== '' ? { recoveryCode } : { code });
    if (done.ok) {
      // A sign-in that began with the typed password proved it: this browser gets its device cookie, as at the password sign-in.
      if (this.#auth.passwordCheckScope().typed) {
        const device = await this.#auth.deviceCookie();
        if (device) ctx.cookies.set(device.name, device.value, device.options);
      }
      return this.redirect().intended().route('office.index');
    }
    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        // The password is typed again: the wait ended (too long, too many wrong codes, a changed password).
        return this.redirect().route('office.login').flash('toast', { kind: 'error', message: this.#translator.get('office.challenge.expired') });
      case 'throttled':
        throw new ValidationError({ [field]: [this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds })] });
      case 'invalid-code': {
        // The last wrong code ended the wait: the password is typed again.
        if (done.error.attemptsLeft === 0) return this.redirect().route('office.login').flash('toast', { kind: 'error', message: this.#translator.get('office.challenge.locked') });
        const what = this.#translator.get(field === 'code' ? 'office.challenge.invalid' : 'office.challenge.invalidRecovery');
        throw new ValidationError({ [field]: [done.error.attemptsLeft <= 2 ? this.#translator.get('office.challenge.invalidLeft', { what, count: done.error.attemptsLeft }) : what] });
      }
    }
  }
}
