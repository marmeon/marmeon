import { Auth } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const LoginRequest = defineRequest({
  schema: r.object({
    // The identifier is normalized here: the throttle key and the lookup see the same value.
    email: r.string().trim().lowercase().required().max(255).email(),
    // Never trimmed: spaces belong to the password. The hasher normalizes Unicode itself.
    password: r.string().required().max(4096),
    // A checkbox: absent when unticked; `on` from an HTML form, `true` from JSON.
    remember: r.boolean().default(false),
  }),
  messages: { 'email.required': 'auth.validation.email_required', 'email.email': 'auth.validation.email_invalid', 'password.required': 'auth.validation.password_required' },
});

export class LoginController extends Controller {
  static request = LoginRequest;

  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password, remember } = ctx.body;
    // The SignedIn event carries the request's address and browser by itself (ClientInfo) — the "new sign-in" notice shows them.
    // The limits sit in attempt(): a minute per client and e-mail, a day per account — counted before the password is checked. An
    // unknown e-mail and a wrong password answer alike — same message, same time.
    const signedIn = await this.#auth.attempt(email, password, { remember });
    if (signedIn.ok) {
      // This browser proved the password: its device cookie keeps it signing in when strangers have used up the account's daily ceiling.
      const device = await this.#auth.deviceCookie();
      if (device) ctx.cookies.set(device.name, device.value, device.options);
      return this.redirect().intended().route('user-profile.me');
    }
    switch (signedIn.error.kind) {
      // The password was right, but the account has a second factor and nobody is signed in yet: on to the code.
      case 'two-factor-required':
        return this.redirect().route('auth.two-factor.challenge');
      case 'throttled': {
        const message = signedIn.error.account ? this.#translator.get('auth.login.locked') : this.#translator.get('auth.login.throttled', { seconds: signedIn.error.retryAfter });
        throw new ValidationError({ email: [message] }, { email });
      }
      case 'invalid-credentials':
        throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
    }
  }
}
