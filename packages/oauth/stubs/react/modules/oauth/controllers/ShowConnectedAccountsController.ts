import { Auth, TwoFactorState, UserProvider, type Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { OAuth } from '@marmeon/oauth';
import { SocialAccounts } from '@marmeon/oauth/accounts';
import { Router } from '@marmeon/router';
import { TARGETS } from '../targets.ts';

/**
 * The panel of connected accounts: what the person has linked, the providers they can still link, and what they can do about the
 * confirmation that linking and removing ask for. An island, placed on a settings page of your app.
 */
export class ShowConnectedAccountsController extends Controller {
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;
  readonly #auth: Auth;
  readonly #users: UserProvider;
  readonly #factors: TwoFactorState;
  readonly #router: Router;

  constructor(oauth: OAuth, accounts: SocialAccounts, auth: Auth, users: UserProvider, factors: TwoFactorState, router: Router) {
    super();
    this.#oauth = oauth;
    this.#accounts = accounts;
    this.#auth = auth;
    this.#users = users;
    this.#factors = factors;
    this.#router = router;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const credentials = await this.#users.findById(ctx.user.id);
    const accounts = await this.#accounts.list();
    // Only what the panel shows. The password hash never leaves the server: the panel learns that there is a password, nothing of it.
    return this.island('oauth/ConnectedAccounts', {
      accounts: accounts.map(({ provider, label, email, nickname, createdAt, lastUsedAt, canConfirm }) => ({
        provider,
        label,
        email,
        nickname,
        createdAt: createdAt.toISOString(),
        lastUsedAt: lastUsedAt?.toISOString() ?? null,
        canConfirm,
      })),
      providers: this.#oauth.providers().map(({ name, label }) => ({ name, label })),
      confirmed: this.#auth.passwordRecentlyConfirmed(),
      hasPassword: credentials !== undefined && credentials.passwordHash !== null,
      hasPasskey: (await this.#factors.factors(ctx.user.id)).includes('passkey'),
      // Where an account with a password confirms, `TARGETS.confirm` of the module.
      confirmUrl: this.#router.url(TARGETS.confirm),
    });
  }
}
