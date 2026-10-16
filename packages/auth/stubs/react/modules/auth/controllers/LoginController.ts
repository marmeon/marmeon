import { Auth, Lockout } from '@marmeon/auth';
import { clientKey, RateLimiter } from '@marmeon/cache';
import { EventDispatcher } from '@marmeon/core';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Queue } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { ACCOUNT_SIGN_INS, ACCOUNT_WINDOW_SECONDS, accountKey, accountNoticeKey, clearAccountFailures } from '../account-failures.ts';
import { SendLockoutMailJob } from '../jobs/SendLockoutMailJob.ts';

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
  readonly #queue: Queue;

  constructor(auth: Auth, limiter: RateLimiter, events: EventDispatcher, translator: Translator, queue: Queue) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#events = events;
    this.#translator = translator;
    this.#queue = queue;
  }

  async handle(ctx: ContextOf<typeof LoginRequest>) {
    const { email, password, remember } = ctx.body;
    // Keyed on the *validated* e-mail, after validation — never on raw input — and the client (an IPv6 address counts as its /64).
    const key = `login:${email}|${clientKey(ctx.ip)}`;
    // Counted BEFORE the password is checked, in one atomic step: guesses sent at once can never all get past the limit
    // (checking first and counting after a failure lets every request that checks before the others through).
    if (!(await this.#limiter.attempt(key, MAX_ATTEMPTS, DECAY_SECONDS))) {
      await this.#events.dispatch(new Lockout(email, ctx.ip));
      const seconds = await this.#limiter.availableIn(key);
      throw new ValidationError({ email: [this.#translator.get('auth.login.throttled', { seconds })] }, { email });
    }

    // The account's own ceiling, whichever clients the guesses come from: 100 password sign-ins a day, counted before the password is
    // checked. Past it nothing is checked — the right password included — and an address without an account gets the same answer
    // and does the same work. The owner still gets in with a password reset or a passkey; a sign-in or a reset starts the count over.
    if (!(await this.#limiter.attempt(accountKey(email), ACCOUNT_SIGN_INS, ACCOUNT_WINDOW_SECONDS))) {
      // Once per window: the owner is told (the job finds out whether there is an account), the app can listen for the event.
      if (await this.#limiter.attempt(accountNoticeKey(email), 1, ACCOUNT_WINDOW_SECONDS)) {
        await this.#events.dispatch(new Lockout(email, ctx.ip));
        await this.#queue.dispatch(SendLockoutMailJob, { email, locale: this.#translator.locale }, { queue: 'mail' });
      }
      throw new ValidationError({ email: [this.#translator.get('auth.login.locked')] }, { email });
    }

    // Unknown e-mail and wrong password answer alike — same message, same time (dummyVerify). The attempt stays counted.
    const signedIn = await this.#auth.attempt(email, password, { remember });
    if (!signedIn.ok) {
      // The password was right, but the account has a second factor and nobody is signed in yet: on to the code. Not counted as
      // a failure — the limiter is cleared like after a sign-in (the code has its own, per account).
      if (signedIn.error.kind === 'two-factor-required') {
        await this.#limiter.clear(key);
        await clearAccountFailures(this.#limiter, email);
        return this.redirect().route('auth.two-factor.challenge');
      }
      throw new ValidationError({ email: [this.#translator.get('auth.login.failed')] }, { email });
    }

    await this.#limiter.clear(key);
    await clearAccountFailures(this.#limiter, email);
    return this.redirect().intended().route('dashboard');
  }
}
