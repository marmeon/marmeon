import { Auth, Lockout } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { EventDispatcher } from '@marmeon/core';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const LoginRequest = defineRequest({
  schema: r.object({
    // The identifier is normalized here, in the schema: the throttle key and the lookup see the same value.
    email: r.string().trim().lowercase().required().max(255).email(),
    // Never trimmed: spaces belong to the password. The hasher normalizes Unicode itself.
    password: r.string().required().max(4096),
    // A checkbox: absent when unticked; `on` from an HTML form, `true` from JSON.
    remember: r.boolean().default(false),
  }),
  messages: { 'email.required': 'auth.validation.email_required', 'email.email': 'auth.validation.email_invalid', 'password.required': 'auth.validation.password_required' },
});

/** Five failed attempts per minute for one e-mail from one address. */
const MAX_ATTEMPTS = 5;
const DECAY_SECONDS = 60;

export class LoginController extends Controller {
  static request = LoginRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;
  readonly #events: EventDispatcher;
  readonly #translator: Translator;

  constructor(auth: Auth, limiter: RateLimiter, events: EventDispatcher, translator: Translator) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#events = events;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password, remember } = ctx.body;
    // Keyed on the *validated* e-mail, after validation — never on raw input.
    const key = `login:${email}|${ctx.ip ?? 'unknown'}`;
    // Counted BEFORE the password is checked, in one atomic step: guesses sent at once can never all get past the limit
    // (checking first and counting after a failure lets every request that checks before the others through).
    if (!(await this.#limiter.attempt(key, MAX_ATTEMPTS, DECAY_SECONDS))) {
      await this.#events.dispatch(new Lockout(email, ctx.ip));
      const seconds = await this.#limiter.availableIn(key);
      throw new ValidationError({ email: [this.#translator.get('auth.login.throttled', { seconds })] }, { email });
    }

    // Unknown e-mail and wrong password answer alike — same message, same time (dummyVerify). The attempt stays counted.
    const signedIn = await this.#auth.attempt(email, password, { remember });
    if (!signedIn.ok) {
      throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
    }

    await this.#limiter.clear(key);
    return this.redirect().intended().route('dashboard');
  }
}
