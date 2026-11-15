import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficeAuth } from './guard.ts';
import { intendedBelow } from './intended.ts';

export const LoginRequest = defineRequest({
  schema: r.object({
    // Normalized here: the throttle key and the lookup see the same value.
    email: r.string().trim().lowercase().required().max(255).email(),
    // Never trimmed: spaces belong to the password.
    password: r.string().required().max(4096),
  }),
});

/** Signs an editor in: the guard's limits (a minute per client and address, a day per account) count before the password is checked. */
export class OfficeLoginController extends Controller {
  static request = LoginRequest;
  static readonly inject = [OfficeAuth, Translator, Session, BackOfficeConfig] as const;

  readonly #auth: OfficeAuth;
  readonly #translator: Translator;
  readonly #session: Session;
  readonly #config: BackOfficeConfig;

  constructor(auth: OfficeAuth, translator: Translator, session: Session, config: BackOfficeConfig) {
    super();
    this.#auth = auth;
    this.#translator = translator;
    this.#session = session;
    this.#config = config;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password } = ctx.body;
    const signedIn = await this.#auth.attempt(email, password);
    if (signedIn.ok) {
      // This browser proved the password: its device cookie keeps the editor signing in when strangers have used up the account's daily ceiling.
      // Without it, anyone who knows an address could lock its owner out for good, and the package has no password reset yet.
      const device = await this.#auth.deviceCookie();
      if (device) ctx.cookies.set(device.name, device.value, device.options);
      // Only a page of the back office: the session keeps one wished-for page for all guards, and the last one stored may be the app's.
      return intendedBelow(this.#session, this.#config.path) ? this.redirect().intended().route('office.index') : this.redirect().route('office.index');
    }
    // An unknown address and a wrong password answer alike. The guard has no second factor yet, so nothing else is expected: whatever else comes back signs nobody in.
    if (signedIn.error.kind === 'throttled') {
      const message = signedIn.error.account ? this.#translator.get('office.login.locked') : this.#translator.get('office.login.throttled', { seconds: signedIn.error.retryAfterSeconds });
      throw new ValidationError({ email: [message] }, { email });
    }
    throw new ValidationError({ email: [this.#translator.get('office.login.failed')] }, { email });
  }
}
