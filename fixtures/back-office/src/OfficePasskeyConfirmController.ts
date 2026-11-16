import type { AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficePasskeys } from './guard.ts';
import { intendedBelow } from './intended.ts';

export const PasskeyConfirmRequest = defineRequest({
  schema: r.object({
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'office.challenge.failed')),
  }),
});

/**
 * Opens the editor's sudo window with a passkey in place of the password, as `ConfirmController` does with the password. The throttle, the event and the
 * check against the stored passkey live in `Passkeys`; every failure answers alike. One request per session at a time (`block()`).
 */
export class OfficePasskeyConfirmController extends Controller {
  static request = PasskeyConfirmRequest;
  static readonly inject = [OfficePasskeys, Translator, Session, BackOfficeConfig] as const;

  readonly #passkeys: OfficePasskeys;
  readonly #translator: Translator;
  readonly #session: Session;
  readonly #config: BackOfficeConfig;

  constructor(passkeys: OfficePasskeys, translator: Translator, session: Session, config: BackOfficeConfig) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
    this.#session = session;
    this.#config = config;
  }

  async handle(ctx: ContextOf<typeof PasskeyConfirmRequest>) {
    const done = await this.#passkeys.confirm(ctx.body.response);
    if (done.ok) return intendedBelow(this.#session, this.#config.path) ? this.redirect().intended().route('office.secure') : this.redirect().route('office.secure');
    if (done.error.kind === 'throttled') return this.json({ error: this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds }) }, { status: 429 });
    return this.json({ error: this.#translator.get('office.challenge.failed') }, { status: 422 });
  }
}
