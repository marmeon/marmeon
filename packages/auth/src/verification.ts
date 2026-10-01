import { createHash, timingSafeEqual } from 'node:crypto';
import { UrlSigner, type Duration } from '@bespokecore/http';
import { Router, type HttpContext, type MiddlewareClass, type Next } from '@bespokecore/router';

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

export interface VerificationLinkOptions {
  /** Absolute links for mails: the app's URL. */
  readonly base: string;
  /** Default `60m`. */
  readonly expiresIn?: Duration;
  /** Default `auth.verification.verify` (a route with `:id` and `:hash`, behind `signed()`). */
  readonly route?: string;
}

/**
 * E-mail verification links (Laravel's `VerifyEmail`): signed, expiring, bound to the user's id and
 * the hash of the address — the controller behind `signed()` asks `matches()` before marking it verified.
 */
export class EmailVerification {
  readonly #signer: UrlSigner;

  constructor(signer: UrlSigner) {
    this.#signer = signer;
  }

  link(user: { readonly id: string | number; readonly email: string }, { base, expiresIn = '60m', route = 'auth.verification.verify' }: VerificationLinkOptions): string {
    return this.#signer.temporarySignedRoute(route, { id: user.id, hash: emailHash(user.email) }, expiresIn, { base });
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

export interface VerifiedOptions {
  /** Named route of the "please verify your e-mail" page (default `auth.verification.notice`). */
  readonly noticeRoute?: string;
}

/**
 * Only for users with a verified e-mail (Laravel's `verified`): after `authenticate()`; the user type
 * must have `email_verified_at`. Others get 403 (JSON) or the notice page.
 */
export function verified(options: VerifiedOptions = {}): MiddlewareClass<{ readonly user: VerifiableUser }, {}> {
  const noticeRoute = options.noticeRoute ?? 'auth.verification.notice';
  const EnsureEmailIsVerified = class {
    readonly #router: Router;

    constructor(router: Router) {
      this.#router = router;
    }

    handle(ctx: HttpContext<{ readonly user: VerifiableUser }>, next: Next<{}>): Promise<Response> | Response {
      if (ctx.user.email_verified_at !== null) return next();
      if (ctx.expectsJson()) return Response.json({ message: 'Your e-mail address is not verified.' }, { status: 403 });
      return new Response(null, { status: 302, headers: { location: this.#router.url(noticeRoute) } });
    }
  };
  Object.defineProperty(EnsureEmailIsVerified, 'name', { value: 'verified' });
  return EnsureEmailIsVerified;
}
