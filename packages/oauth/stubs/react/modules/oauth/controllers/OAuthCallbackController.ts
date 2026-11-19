import { Auth } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OAuth, type SocialUser } from '@marmeon/oauth';
import { SocialAccounts } from '@marmeon/oauth/accounts';
import { Queue } from '@marmeon/queue';
import { Router } from '@marmeon/router';
import { SendSocialAccountExistsMailJob } from '../jobs/SendSocialAccountExistsMailJob.ts';
import { TARGETS } from '../targets.ts';

/** The texts of the sign-in page's notices (`oauth.messages.*`), by what went wrong. */
type Notice = 'failed' | 'cancelled' | 'account_exists' | 'registration_closed' | 'email_required' | 'email_unverified' | 'session_ended';

/** The notices of the panel's flows: linking an account and confirming with one. */
type PanelNotice = 'signed_in' | 'flow_failed' | 'flow_cancelled' | 'linked' | 'link_confirm_first' | 'link_taken' | 'link_provider_linked' | 'link_email_unconfirmed' | 'link_invalid' | 'confirmed' | 'confirm_not_fresh' | 'confirm_not_linked' | 'confirm_expired';

/**
 * Where the provider sends the browser back. It completes the flow, and branches on the intent the flow was started with: a sign-in signs
 * in, a link adds the account to the signed-in user, a confirmation opens the confirmation window. Any other intent is not this
 * controller's to serve. A refusal of a sign-in is a notice on the sign-in page; one of a link or a confirmation leads back with its own
 * notice. None says more than the person may learn (no provider text, no query, no address).
 */
export class OAuthCallbackController extends Controller {
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;
  readonly #auth: Auth;
  readonly #queue: Queue;
  readonly #translator: Translator;
  readonly #router: Router;

  constructor(oauth: OAuth, accounts: SocialAccounts, auth: Auth, queue: Queue, translator: Translator, router: Router) {
    super();
    this.#oauth = oauth;
    this.#accounts = accounts;
    this.#auth = auth;
    this.#queue = queue;
    this.#translator = translator;
    this.#router = router;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    // The flow is bound to the user it was started for: a signed-in person passes their id, a guest passes none.
    const userId = await this.#auth.id();
    const done = await this.#oauth.callback(ctx.params.provider, new URL(ctx.request.url).searchParams, userId === undefined ? {} : { userId });
    if (!done.ok) {
      if (done.error.kind === 'unknown-provider') abort(404);
      // Nothing is known of the intent here (the flow did not complete). A signed-in person goes back with the message: the sign-in page would turn them
      // away to `home` and the message with it. A guest ends on the sign-in page.
      const cancelled = done.error.kind === 'cancelled';
      if (userId !== undefined) return this.#back('error', cancelled ? 'flow_cancelled' : 'flow_failed');
      return this.#login(cancelled ? 'cancelled' : 'failed');
    }
    const { user, intent } = done.value;
    // The callback address is fixed per provider, so a flow started for another intent (linking an account, confirming one) comes back here
    // too: each is a branch on `intent`. A link or a confirmation belongs to a signed-in user (the flow was bound to one, and `callback()`
    // took the user's id): nobody signed in means a flow that cannot be served, and any other intent is not this controller's either.
    if (intent === 'link' || intent === 'confirm') {
      if (userId === undefined) return this.#login('failed');
      return intent === 'link' ? this.#link(user) : this.#confirm(user);
    }
    if (intent !== 'sign-in') return userId === undefined ? this.#login('failed') : this.#back('error', 'flow_failed');

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
        // Somebody is signed in already: back with the message, since the sign-in page would turn them away and the message with it.
        return this.#back('error', 'signed_in');
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

  /** Links the account; no refusal moves anything. `SocialAccounts.link()` throws inside a database transaction, so none is opened here. */
  async #link(user: SocialUser) {
    const linked = await this.#accounts.link(user);
    if (linked.ok) return this.#back('success', 'linked');
    switch (linked.error.kind) {
      case 'signed-out':
        return this.#login('session_ended');
      case 'confirmation-required':
        // The window ran out during the round trip to the provider: confirm first, then start again.
        return this.#back('error', 'link_confirm_first');
      case 'taken':
        return this.#back('error', 'link_taken');
      case 'provider-linked':
        return this.#back('error', 'link_provider_linked');
      case 'email-unconfirmed':
        return this.#back('error', 'link_email_unconfirmed');
      case 'invalid-account':
        return this.#back('error', 'link_invalid');
    }
  }

  /** Opens the confirmation window, counted from the sign-in at the provider. Every refusal leaves it closed. */
  async #confirm(user: SocialUser) {
    const confirmed = await this.#accounts.confirm(user);
    // Back to the page the guard sent the person away from (`confirmedPassword()` stored it), else home.
    if (confirmed.ok) return this.redirect().intended().route(TARGETS.home).flash('toast', { kind: 'success', message: this.#translator.get('oauth.messages.confirmed') });
    switch (confirmed.error.kind) {
      case 'signed-out':
        return this.#login('session_ended');
      case 'not-reauthenticated':
        return this.#back('error', 'confirm_not_fresh');
      case 'not-linked':
        return this.#back('error', 'confirm_not_linked');
      case 'expired':
        return this.#back('error', 'confirm_expired');
    }
  }

  #back(kind: 'success' | 'error', notice: PanelNotice) {
    return this.back(this.#router.url(TARGETS.home)).flash('toast', { kind, message: this.#translator.get(`oauth.messages.${notice}`) });
  }

  #login(notice: Notice) {
    return this.redirect().route(TARGETS.login).flash('toast', { kind: 'error', message: this.#translator.get(`oauth.messages.${notice}`) });
  }
}
