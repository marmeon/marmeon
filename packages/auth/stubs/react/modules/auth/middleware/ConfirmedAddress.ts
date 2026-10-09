import { AuthConfig, verified, type VerifiableUser } from '@marmeon/auth';
import type { HttpContext, Next } from '@marmeon/http';
import { Router } from '@marmeon/router';

const Verified = verified();

/**
 * `verified()` while registration is private (the default): the app is for confirmed addresses only — whoever signed up
 * with somebody else's address (it was free then) signs in, but sees nothing but the notice until the link from that inbox is
 * clicked while signed in. With `AUTH_PRIVATE_REGISTRATION=false` it lets everyone signed in through:
 * a sign-up signs in at once, and a typo in a new address (changed at once, unverified) can still be fixed on the security page.
 * Want a confirmed address either way? Put `verified()` of @marmeon/auth in its place.
 */
export class ConfirmedAddress {
  readonly #verified: InstanceType<typeof Verified> | undefined;

  constructor(config: AuthConfig, router: Router) {
    this.#verified = config.privateRegistration ? new Verified(router) : undefined;
  }

  handle(ctx: HttpContext<{ readonly user: VerifiableUser }>, next: Next<{}>) {
    return this.#verified ? this.#verified.handle(ctx, next) : next();
  }
}
