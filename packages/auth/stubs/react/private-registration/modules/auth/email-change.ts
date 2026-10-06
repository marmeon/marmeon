import { createHash, randomBytes } from 'node:crypto';

/** How long a pending change of address waits for its link to be clicked — the link expires with it. */
export const EMAIL_CHANGE_MINUTES = 60;

/**
 * A new change request's token — the link carries it, the users table keeps only its hash: a link is bound to its account
 * (the row) and to this one request (a newer request, a click, the prune replace or clear the hash).
 */
export function newEmailChangeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: emailChangeTokenHash(token) };
}

export function emailChangeTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
