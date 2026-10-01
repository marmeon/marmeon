import { Auth, Lockout } from '@bespokecore/auth';
import { RateLimiter } from '@bespokecore/cache';
import { EventDispatcher } from '@bespokecore/core';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import * as v from 'valibot';

export const LoginRequest = defineRequest({
  schema: v.object({
    // The identifier is normalized here (W2 rule): the throttle key and the lookup see the same value.
    email: v.pipe(v.string('Enter your e-mail address.'), v.trim(), v.toLowerCase(), v.nonEmpty('Enter your e-mail address.'), v.maxLength(255), v.email('Enter a valid e-mail address.')),
    // Never trimmed: spaces belong to the password. The hasher normalizes Unicode itself.
    password: v.pipe(v.string('Enter your password.'), v.nonEmpty('Enter your password.'), v.maxLength(4096)),
  }),
});

/** Five failed attempts per minute for one e-mail from one address (Laravel Breeze's default). */
const MAX_ATTEMPTS = 5;
const DECAY_SECONDS = 60;

export class LoginController extends Controller {
  static request = LoginRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;
  readonly #events: EventDispatcher;

  constructor(auth: Auth, limiter: RateLimiter, events: EventDispatcher) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#events = events;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password } = ctx.body;
    // Keyed on the *validated* e-mail, after validation — never on raw input (Breeze's ensureIsNotRateLimited).
    const key = `login:${email}|${ctx.ip ?? 'unknown'}`;
    if (await this.#limiter.tooManyAttempts(key, MAX_ATTEMPTS)) {
      await this.#events.dispatch(new Lockout(email, ctx.ip));
      const seconds = await this.#limiter.availableIn(key);
      throw new ValidationError({ email: [`Too many login attempts. Please try again in ${seconds} seconds.`] }, { email });
    }

    // Unknown e-mail and wrong password answer alike — same message, same time (dummyVerify).
    if (!(await this.#auth.attempt(email, password))) {
      await this.#limiter.hit(key, DECAY_SECONDS);
      throw new ValidationError({ email: ['These credentials do not match our records.'] }, { email });
    }

    await this.#limiter.clear(key);
    return this.redirect().intended().route('user-profile.me');
  }
}
