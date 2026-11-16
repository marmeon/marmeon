import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficeTwoFactor } from './guard.ts';
import { intendedBelow } from './intended.ts';

export const TwoFactorVerifyRequest = defineRequest({
  schema: r.object({ code: r.string().trim().max(32).default(''), recovery_code: r.string().trim().max(64).default('') }),
});

/**
 * Proves the second factor in the session the editor already has, and goes back to the page that asked for it. The throttle lives in the guard's
 * `TwoFactor`; a wrong code does not end the session. One request per session at a time (`block()`).
 */
export class OfficeTwoFactorVerifyController extends Controller {
  static request = TwoFactorVerifyRequest;
  static readonly inject = [OfficeTwoFactor, Translator, Session, BackOfficeConfig] as const;

  readonly #twoFactor: OfficeTwoFactor;
  readonly #translator: Translator;
  readonly #session: Session;
  readonly #config: BackOfficeConfig;

  constructor(twoFactor: OfficeTwoFactor, translator: Translator, session: Session, config: BackOfficeConfig) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
    this.#session = session;
    this.#config = config;
  }

  async handle(ctx: ContextOf<typeof TwoFactorVerifyRequest>) {
    const { code, recovery_code: recoveryCode } = ctx.body;
    const field = recoveryCode !== '' ? 'recovery_code' : 'code';
    const done = await this.#twoFactor.stepUp(recoveryCode !== '' ? { recoveryCode } : { code });
    // Only a page of the back office, as at the sign-in.
    if (done.ok) return intendedBelow(this.#session, this.#config.path) ? this.redirect().intended().route('office.security') : this.redirect().route('office.security');
    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        // No factor to prove (it was turned off meanwhile): the security page is where one is set up.
        return this.redirect().route('office.security');
      case 'throttled':
        throw new ValidationError({ [field]: [this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds })] });
      case 'invalid-code': {
        const what = this.#translator.get(field === 'code' ? 'office.challenge.invalid' : 'office.challenge.invalidRecovery');
        throw new ValidationError({ [field]: [done.error.attemptsLeft <= 2 ? this.#translator.get('office.challenge.invalidLeft', { what, count: done.error.attemptsLeft }) : what] });
      }
    }
  }
}
