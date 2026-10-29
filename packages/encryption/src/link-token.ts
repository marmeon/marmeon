import { createHash, randomBytes } from 'node:crypto';

/** A link's token and the hash to store: the link carries `token`, the table keeps `hash`. See {@link linkToken}. */
export interface LinkToken {
  /** 43 characters of base64url (256 random bits) — goes into the link, never into the database in the clear. */
  readonly token: string;
  /** Hex SHA-256 (64 characters) of `marmeon.link-token.v1`, a NUL character and the token, not of the token alone — what the table stores and `hashLinkToken()` finds it by. */
  readonly hash: string;
}

const SHAPE = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = 'marmeon.link-token.v1\0';
const MALFORMED_DOMAIN = 'marmeon.link-token.malformed\0';
const LONGEST = 512;

/**
 * A new token for a link that works once or can be revoked, with the hash to keep in its row. 256 random bits need no slow hash and
 * no key: a stolen table opens nothing, and rotating `APP_KEY` does not kill a link. See `docs/urls.md#a-link-that-is-used-once`.
 */
export function linkToken(): LinkToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashLinkToken(token) };
}

/**
 * The hash of a token a request brought, to look it up by the unique index of its column: the hex SHA-256 of `marmeon.link-token.v1`,
 * a NUL character and the token, a stored format. A value of any other shape is hashed under
 * a domain of its own (cut to 512 characters), so it matches no row, costs the same as a real token and never throws. See
 * `docs/urls.md#a-link-that-is-used-once`.
 */
export function hashLinkToken(presented: string): string {
  if (typeof presented === 'string' && SHAPE.test(presented)) return sha256(`${DOMAIN}${presented}`);
  return sha256(`${MALFORMED_DOMAIN}${(typeof presented === 'string' ? presented.slice(0, LONGEST) : '')}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
