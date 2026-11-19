import type { SocialUser } from './definition.ts';

/** What the flow proved about a `SocialUser`: the verdict, and a copy of the identity it was given for. */
export interface VerifiedInfo {
  readonly intent: string;
  readonly flowUserId: string | undefined;
  /** Milliseconds since the epoch — a number, because a frozen `Date` can still be changed with `setTime`. */
  readonly reauthenticatedAt?: number;
  /** The identity as it was when the flow marked it. Read this, never the user object, which the caller holds. */
  readonly subject: { readonly provider: string; readonly id: string; readonly email: string | null; readonly emailVerified: boolean };
}

// Keyed by the object the flow handed out. The entry holds a copy of the identity and the user is frozen, so what the verdict
// covers cannot be changed afterwards through either.
const verified = new WeakMap<object, VerifiedInfo>();

/** Marks `user` as the result of a completed flow, freezes it and its tokens, and records its identity. */
export function markVerified(user: SocialUser, info: Pick<VerifiedInfo, 'intent' | 'flowUserId' | 'reauthenticatedAt'>): void {
  Object.freeze(user.tokens.scopes);
  Object.freeze(user.tokens);
  Object.freeze(user);
  verified.set(
    user,
    Object.freeze({
      intent: info.intent,
      flowUserId: info.flowUserId,
      ...(info.reauthenticatedAt === undefined ? {} : { reauthenticatedAt: info.reauthenticatedAt }),
      subject: Object.freeze({ provider: user.provider, id: user.id, email: user.email, emailVerified: user.emailVerified }),
    }),
  );
}

/** What the flow proved about `user`, or `undefined` for anything that did not come out of it. */
export function verifiedInfo(user: unknown): VerifiedInfo | undefined {
  return typeof user === 'object' && user !== null ? verified.get(user) : undefined;
}

/** Like {@link verifiedInfo}, and forgets the entry: a result is spent once. */
export function consumeVerified(user: unknown): VerifiedInfo | undefined {
  const info = verifiedInfo(user);
  if (info !== undefined) verified.delete(user as object);
  return info;
}
