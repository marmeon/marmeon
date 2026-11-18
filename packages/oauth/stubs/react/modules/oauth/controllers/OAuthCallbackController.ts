import { Auth } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OAuth } from '@marmeon/oauth';
import { SocialAccounts } from '@marmeon/oauth/accounts';
import { Queue } from '@marmeon/queue';
import { SendSocialAccountExistsMailJob } from '../jobs/SendSocialAccountExistsMailJob.ts';
import { TARGETS } from '../targets.ts';

/** The texts of the sign-in page's notices (`oauth.messages.*`), by what went wrong. */
type Notice = 'failed' | 'cancelled' | 'account_exists' | 'registration_closed' | 'email_required' | 'email_unverified' | 'signed_in';

/**
 * Where the provider sends the browser back. It completes the flow, and branches only on the intent the flow was started with: a
 * sign-in signs in, any other intent is not this controller's to serve and ends on the sign-in page. Every refusal is a notice on the
 * sign-in page; none says more than the person may learn (no provider text, no query, no address).
 */
export class OAuthCallbackController extends Controller {
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;
  readonly #auth: Auth;
  readonly #queue: Queue;
  readonly #translator: Translator;

  constructor(oauth: OAuth, accounts: SocialAccounts, auth: Auth, queue: Queue, translator: Translator) {
    super();
    this.#oauth = oauth;
    this.#accounts = accounts;
    this.#auth = auth;
    this.#queue = queue;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    // The flow is bound to the user it was started for: a signed-in person passes their id, a guest passes none.
    const userId = await this.#auth.id();
    const done = await this.#oauth.callback(ctx.params.provider, new URL(ctx.request.url).searchParams, userId === undefined ? {} : { userId });
    if (!done.ok) {
      if (done.error.kind === 'unknown-provider') abort(404);
      return this.#login(done.error.kind === 'cancelled' ? 'cancelled' : 'failed');
    }
    const { user, intent } = done.value;
    // The callback address is fixed per provider, so a flow started for another intent (linking an account, confirming one) comes back here
    // too: each is added as a branch on `intent` in this controller. Until then, any intent but a sign-in ends on the sign-in page.
    if (intent !== 'sign-in') return this.#login('failed');

    const signedIn = await this.#accounts.signIn(user);
    if (signedIn.ok) {
      if (signedIn.value.kind === 'two-factor-required') return this.redirect().route(TARGETS.twoFactorChallenge);
      return this.redirect().intended().route(TARGETS.home);
    }
    switch (signedIn.error.kind) {
      case 'account-exists':
        return this.#login('account_exists');
      case 'registration-closed':
        return this.#login('registration_closed');
      case 'email-required':
        return this.#login('email_required');
      case 'signed-in':
        return this.#login('signed_in');
      case 'email-unverified': {
        // Private registration: an address the provider did not verify gets this one answer, whether or not an account has it. The owner of an
        // account that has it hears about the attempt by mail, from a job that decides on its own (the request tells nothing, and costs the same).
        const label = this.#oauth.providers().find((provider) => provider.name === user.provider)?.label ?? user.provider;
        if (user.email !== null) await this.#queue.dispatch(SendSocialAccountExistsMailJob, { email: user.email.trim().toLowerCase(), provider: label, locale: this.#translator.locale }, { queue: 'mail' });
        return this.#login('email_unverified');
      }
      case 'invalid-account':
        return this.#login('failed');
    }
  }

  #login(notice: Notice) {
    return this.redirect().route(TARGETS.login).flash('toast', { kind: 'error', message: this.#translator.get(`oauth.messages.${notice}`) });
  }
}
