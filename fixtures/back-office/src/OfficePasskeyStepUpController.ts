import type { AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficeTwoFactor } from './guard.ts';
import { intendedBelow } from './intended.ts';

export const PasskeyStepUpRequest = defineRequest({
  schema: r.object({
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'office.challenge.failed')),
  }),
});

/** Proves the second factor with a passkey in the editor's session, and goes back to the page that asked. A wrong response does not end the session. One request per session at a time (`block()`). */
export class OfficePasskeyStepUpController extends Controller {
  static request = PasskeyStepUpRequest;
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

  async handle(ctx: ContextOf<typeof PasskeyStepUpRequest>) {
    const done = await this.#twoFactor.stepUp({ passkey: ctx.body.response });
    // Only a page of the back office, as at the sign-in.
    if (done.ok) return intendedBelow(this.#session, this.#config.path) ? this.redirect().intended().route('office.security') : this.redirect().route('office.security');
    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        return this.redirect().route('office.security');
      case 'throttled':
        return this.json({ error: this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds }) }, { status: 429 });
      case 'invalid-code':
        return this.json({ error: this.#translator.get('office.challenge.failed') }, { status: 422 });
    }
  }
}
