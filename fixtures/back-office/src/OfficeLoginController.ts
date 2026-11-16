import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeAuth } from './guard.ts';

export const LoginRequest = defineRequest({
  schema: r.object({
    // Normalized here: the throttle key and the lookup see the same value.
    email: r.string().trim().lowercase().required().max(255).email(),
    // Never trimmed: spaces belong to the password.
    password: r.string().required().max(4096),
  }),
});

/** Signs an editor in: the guard's limits (a minute per client and address, a day per account) count before the password is checked. An editor with a second factor goes on to the code. */
export class OfficeLoginController extends Controller {
  static request = LoginRequest;
  static readonly inject = [OfficeAuth, Translator] as const;

  readonly #auth: OfficeAuth;
  readonly #translator: Translator;

  constructor(auth: OfficeAuth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password } = ctx.body;
    const signedIn = await this.#auth.attempt(email, password);
    if (signedIn.ok) {
      // This browser proved the password: its device cookie keeps the editor signing in when strangers have used up the account's daily ceiling.
      // Without it, anyone who knows an address could lock its owner out for good, and the package has no password reset yet.
      const device = await this.#auth.deviceCookie();
      if (device) ctx.cookies.set(device.name, device.value, device.options);
      return this.redirect().intended().route('office.index');
    }
    // The password was right, but the editor has a second factor and nobody is signed in yet: on to the code (or passkey). The guard's sign-in waits for it.
    if (signedIn.error.kind === 'two-factor-required') return this.redirect().route('office.two-factor.challenge');
    // An unknown address and a wrong password answer alike; whatever else comes back signs nobody in.
    if (signedIn.error.kind === 'throttled') {
      const message = signedIn.error.account ? this.#translator.get('office.login.locked') : this.#translator.get('office.login.throttled', { seconds: signedIn.error.retryAfterSeconds });
      throw new ValidationError({ email: [message] }, { email });
    }
    throw new ValidationError({ email: [this.#translator.get('office.login.failed')] }, { email });
  }
}
