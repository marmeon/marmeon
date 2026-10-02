import { Auth, Lockout } from '@bespokecore/auth';
import { RateLimiter } from '@bespokecore/cache';
import { EventDispatcher } from '@bespokecore/core';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';

export const LoginRequest = defineRequest({
  schema: v.object({
    // The identifier is normalized here (W2 rule): the throttle key and the lookup see the same value.
    email: v.pipe(
      v.string(trans('auth.validation.email_required')),
      v.trim(),
      v.toLowerCase(),
      v.nonEmpty(trans('auth.validation.email_required')),
      v.maxLength(255),
      v.email(trans('auth.validation.email_invalid')),
    ),
    // Never trimmed: spaces belong to the password. The hasher normalizes Unicode itself.
    password: v.pipe(v.string(trans('auth.validation.password_required')), v.nonEmpty(trans('auth.validation.password_required')), v.maxLength(4096)),
    // A checkbox: absent when unticked; `on` from an HTML form, `true` from JSON.
    remember: v.optional(v.pipe(v.union([v.boolean(), v.literal('on')]), v.transform((value) => value !== false)), false),
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
    // Keyed on the *validated* e-mail, after validation — never on raw input (Breeze's ensureIsNotRateLimited).
    const key = `login:${email}|${ctx.ip ?? 'unknown'}`;
    // Counted BEFORE the password is checked, in one atomic step: guesses sent at once can never all get past the limit
    // (checking first and counting after a failure lets every request that checks before the others through).
    if (!(await this.#limiter.attempt(key, MAX_ATTEMPTS, DECAY_SECONDS))) {
      await this.#events.dispatch(new Lockout(email, ctx.ip));
      const seconds = await this.#limiter.availableIn(key);
      throw new ValidationError({ email: [this.#translator.get('auth.login.throttled', { seconds })] }, { email });
    }

    // Unknown e-mail and wrong password answer alike — same message, same time (dummyVerify). The attempt stays counted.
    if (!(await this.#auth.attempt(email, password, { remember }))) {
      throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
    }

    await this.#limiter.clear(key);
    return this.redirect().intended().route('user-profile.me');
  }
}
