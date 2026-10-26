import { createHash, timingSafeEqual } from 'node:crypto';
import type { Duration } from '@marmeon/core';
import { UrlSigner } from '@marmeon/http';
import { addVary, EXPECTS_JSON_VARY, Router, type CheckRouteName, type HttpContext, type MiddlewareClass, type Next, type RouteName, type RouteNameInput } from '@marmeon/router';
import { urlFor } from '@marmeon/router/url';

// These answers are chosen by `expectsJson`: a shared cache must not hand one variant to the other client.
const VARY = addVary(undefined, EXPECTS_JSON_VARY);

/** What a verifiable user has: an id, an e-mail and when it was verified. */
export interface VerifiableUser {
  readonly id: string | number;
  readonly email: string;
  readonly email_verified_at: string | Date | null;
}

/** The hash of an e-mail in a verification link: a link for an old address stops working when the address changes. */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}

export interface VerificationLinkOptions<N extends string = string> {
  /** Absolute links for mails: the app's URL. */
  readonly base: string;
  /** Default 60 minutes. */
  readonly expiresIn?: Duration;
  /** Default `auth.verification.verify` (a route with `:id` and `:hash`, behind `signed()`). */
  readonly route?: CheckRouteName<N>;
}

/**
 * E-mail verification links: signed, expiring, bound to the user's id and the hash of the address — the controller
 * behind `signed()` asks `matches()` before marking it verified.
 */
export class EmailVerification {
  readonly #signer: UrlSigner;

  /** @internal Built by the container. */
  constructor(signer: UrlSigner) {
    this.#signer = signer;
  }

  link<const N extends RouteNameInput = never>(user: { readonly id: string | number; readonly email: string }, options: VerificationLinkOptions<N>): string {
    const { base, expiresIn = { minutes: 60 } } = options;
    // A configurable name is only known at runtime: checked there (`Route [...] is not defined`).
    const route = (options.route ?? 'auth.verification.verify') as RouteName;
    return this.#signer.signedRoute(route, { id: user.id, hash: emailHash(user.email) }, { expiresIn, base });
  }

  /**
   * Whether a (signed) link is for `user` and their current address. A signed link of someone else
   * opened while signed in is `false`: the signature proves the app made it, not that it is yours.
   */
  matches(user: { readonly id: string | number; readonly email: string }, params: { readonly id: string; readonly hash: string }): boolean {
    if (params.id !== String(user.id)) return false;
    const expected = Buffer.from(emailHash(user.email));
    const given = Buffer.from(params.hash);
    return expected.byteLength === given.byteLength && timingSafeEqual(expected, given);
  }
}

export interface VerifiedOptions<N extends string = string> {
  /** Named route of the "please verify your e-mail" page (default `auth.verification.notice`). */
  readonly noticeRoute?: CheckRouteName<N>;
}

/**
 * Only for users with a verified e-mail: after `authenticate()`; the user type
 * must have `email_verified_at`. Others get 403 (JSON) or the notice page.
 */
export function verified<const N extends RouteNameInput = never>(options: VerifiedOptions<N> = {}): MiddlewareClass<{ readonly user: VerifiableUser }, {}> {
  const noticeRoute: string = options.noticeRoute ?? 'auth.verification.notice';
  const EnsureEmailIsVerified = class {
    readonly #router: Router;

    constructor(router: Router) {
      this.#router = router;
    }

    handle(ctx: HttpContext<{ readonly user: VerifiableUser }>, next: Next<{}>): Promise<Response> | Response {
      // Fail closed: a user whose provider did not load the column (undefined) is not verified either.
      if (ctx.user.email_verified_at != null) return next();
      if (ctx.expectsJson()) return Response.json({ message: 'Your e-mail address is not verified.' }, { status: 403, headers: VARY });
      return new Response(null, { status: 302, headers: { location: urlFor(this.#router, noticeRoute), ...VARY } });
    }
  };
  Object.defineProperty(EnsureEmailIsVerified, 'name', { value: 'verified' });
  return EnsureEmailIsVerified;
}
