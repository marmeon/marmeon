import { createHash, randomInt } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Clock, token } from '@marmeon/core';
import { Connections, sql, type Generated, type JsonColumn, type Secret } from '@marmeon/database';
import type { Duration } from '@marmeon/http';
import { AuthConfig } from './config.ts';

/** The table the app's migration creates (`make:auth` writes it) — see {@link AccessTokenTable}. */
export const ACCESS_TOKEN_TABLE = 'marmeon_personal_access_tokens';

/**
 * The columns {@link DatabaseAccessTokens} needs — the `marmeon_personal_access_tokens` migration `make:auth` writes into
 * `modules/auth/migrations/` creates them (the token only as its hash, a unique `secret()` column).
 */
export interface AccessTokenTable {
  id: Generated<AccessTokenId>;
  user_id: number | string;
  name: string;
  token_hash: Secret<string>;
  abilities: JsonColumn;
  last_used_at: string | Date | null;
  expires_at: string | Date | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** The columns readiness waits for on `marmeon_personal_access_tokens`. */
export const ACCESS_TOKEN_COLUMNS = ['id', 'user_id', 'name', 'token_hash', 'abilities', 'last_used_at', 'expires_at', 'created_at', 'updated_at'] as const satisfies readonly (keyof AccessTokenTable)[];

/** The primary key of a token row: a number in the starter kit's table, a string in one with UUID keys. */
export type AccessTokenId = number | string;

/** A token as the app sees it — never with its secret. */
export interface AccessToken {
  readonly id: AccessTokenId;
  readonly userId: number | string;
  readonly name: string;
  readonly abilities: readonly string[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/** What `authenticate('api')` adds next to the user: the token the request came with. */
export interface WithToken {
  readonly token: AccessToken;
}

/**
 * Personal access tokens: opaque, `marmeon_<40 characters><crc32>`. The prefix and the checksum let secret scanners find leaked
 * tokens; only a SHA-256 of the secret, under a prefix of its own, is stored and looked up — 62⁴⁰ ≈ 2²³⁸ possibilities need no
 * slow hash, and a slow hash per API request would be a lever for anyone sending invalid tokens. See `docs/api-tokens.md#the-token-format`.
 */
export interface AccessTokenStore {
  /** A new token — the plain text is returned once and never stored. */
  create(userId: number | string, name: string, options?: { abilities?: readonly string[]; expiresIn?: Duration }): Promise<{ plainText: string; token: AccessToken }>;
  /** The token for a presented plain text — `undefined` for malformed, unknown, wrong, revoked or expired ones, all alike. */
  find(plainText: string): Promise<AccessToken | undefined>;
  /** Notes the use (at most once a minute, not a write per request). */
  touch(token: AccessToken): Promise<void>;
  list(userId: number | string): Promise<AccessToken[]>;
  /** Revokes one token of the user — `false` if the user has no such token. */
  revoke(userId: number | string, id: AccessTokenId): Promise<boolean>;
  /** Revokes every token of the user (a new password with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`) — how many. */
  revokeAll(userId: number | string): Promise<number>;
  /**
   * Deletes the tokens that expired more than `graceSeconds` ago (`marmeon auth:prune-tokens`) — they stop working when
   * they expire, but stay listed until pruned. How many. Tokens without an expiry stay until revoked.
   */
  prune(graceSeconds?: number): Promise<number>;
  /** Revokes the tokens of every user (`AccountSessions.endEveryone()`, unless `accessTokens: false`) — how many. */
  revokeEveryone?(): Promise<number>;
}
export const AccessTokenStore = token<AccessTokenStore>('AccessTokenStore');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UNIT = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

function seconds(duration: Duration): number {
  if (typeof duration === 'number') return duration;
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new TypeError(`Invalid duration "${duration}".`);
  return Number(match[1]) * UNIT[match[2] as keyof typeof UNIT];
}

const checksum = (value: string) => crc32(value).toString(16).padStart(8, '0');

/** The domain the hash of a token's secret is taken in: a secret hashed any other way (the plain SHA-256 of tokens with a `|`, the form issued before) finds no row. */
const HASH_DOMAIN = 'marmeon-access-token:v2:';
/** The domain of a presented string that is no token: it costs the same lookup and can match no stored hash. */
const MALFORMED_DOMAIN = 'marmeon-access-token:malformed:';

/** What is stored for a token — and what is looked up for the one presented. */
export function hashToken(value: string): string {
  return sha256(`${HASH_DOMAIN}${value}`);
}

/** Checks the shape and the checksum of a presented token — without the database. */
export function parseAccessToken(plainText: string, prefix: string): { secret: string } | undefined {
  if (typeof plainText !== 'string' || !plainText.startsWith(prefix)) return undefined;
  const match = /^([A-Za-z0-9]{40})([0-9a-f]{8})$/.exec(plainText.slice(prefix.length));
  if (!match) return undefined;
  const [, secret, sum] = match as unknown as [string, string, string];
  // The checksum covers prefix and secret: a typo anywhere fails here.
  if (checksum(`${prefix}${secret}`) !== sum) return undefined;
  return { secret };
}

/** The default {@link AccessTokenStore}, on the app's `marmeon_personal_access_tokens` table. */
export class DatabaseAccessTokens implements AccessTokenStore {
  readonly #connections: Connections;
  readonly #prefix: string;
  readonly #clock: Clock;

  constructor(connections: Connections, config: AuthConfig, clock: Clock) {
    this.#connections = connections;
    this.#prefix = config.tokenPrefix;
    this.#clock = clock;
  }

  async create(userId: number | string, name: string, { abilities = ['*'], expiresIn }: { abilities?: readonly string[]; expiresIn?: Duration } = {}) {
    const secret = Array.from({ length: 40 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const now = new Date(this.#clock.now());
    const row = await this.#db()
      .insertInto(ACCESS_TOKEN_TABLE)
      .values({
        user_id: userId,
        name,
        token_hash: hashToken(secret),
        abilities: JSON.stringify(abilities),
        last_used_at: null,
        expires_at: expiresIn === undefined ? null : new Date(now.getTime() + seconds(expiresIn) * 1000),
        created_at: now,
        updated_at: now,
      })
      .returning(['id', 'user_id', 'name', 'abilities', 'last_used_at', 'expires_at', 'created_at'])
      .executeTakeFirstOrThrow();
    const body = `${this.#prefix}${secret}`;
    return { plainText: `${body}${checksum(body)}`, token: toToken(row) };
  }

  async find(plainText: string): Promise<AccessToken | undefined> {
    if (typeof plainText !== 'string' || !plainText.startsWith(this.#prefix)) return undefined;
    // Whatever the app's prefix starts runs the same indexed query, found or not: a token with a `|` (the form issued before), a
    // mistyped one, a cut-off one and an unknown one cost the same and get the same answer. A string of the wrong shape is hashed
    // whole under a domain of its own, so it matches no row. The hash is not the sender's to choose, so finding it in the index
    // tells nothing about it.
    const parsed = parseAccessToken(plainText, this.#prefix);
    const row = await this.#db()
      .selectFrom(ACCESS_TOKEN_TABLE)
      .select(['id', 'user_id', 'name', 'abilities', 'last_used_at', 'expires_at', 'created_at'])
      .where(sql<boolean>`${sql.ref('token_hash')} = ${parsed ? hashToken(parsed.secret) : sha256(`${MALFORMED_DOMAIN}${plainText}`)}`)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= this.#clock.now()) return undefined;
    return toToken(row);
  }

  async touch(token: AccessToken): Promise<void> {
    if (token.lastUsedAt !== null && this.#clock.now() - new Date(token.lastUsedAt).getTime() < 60_000) return;
    await this.#db().updateTable(ACCESS_TOKEN_TABLE).set({ last_used_at: new Date(this.#clock.now()) }).where('id', '=', token.id).execute();
  }

  async list(userId: number | string): Promise<AccessToken[]> {
    const rows = await this.#db()
      .selectFrom(ACCESS_TOKEN_TABLE)
      .select(['id', 'user_id', 'name', 'abilities', 'last_used_at', 'expires_at', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
    return rows.map(toToken);
  }

  async revoke(userId: number | string, id: AccessTokenId): Promise<boolean> {
    const result = await this.#db().deleteFrom(ACCESS_TOKEN_TABLE).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async revokeAll(userId: number | string): Promise<number> {
    const result = await this.#db().deleteFrom(ACCESS_TOKEN_TABLE).where('user_id', '=', userId).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async revokeEveryone(): Promise<number> {
    return Number((await this.#db().deleteFrom(ACCESS_TOKEN_TABLE).executeTakeFirst()).numDeletedRows);
  }

  async prune(graceSeconds = 0): Promise<number> {
    const result = await this.#db()
      .deleteFrom(ACCESS_TOKEN_TABLE)
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', new Date(this.#clock.now() - graceSeconds * 1000))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #db() {
    return this.#connections.get<{ [ACCESS_TOKEN_TABLE]: AccessTokenTable }>();
  }
}

function toToken(row: { id: AccessTokenId; user_id: number | string; name: string; abilities: unknown; last_used_at: string | Date | null; expires_at: string | Date | null; created_at: string | Date }): AccessToken {
  const iso = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    abilities: Array.isArray(row.abilities) ? row.abilities.map(String) : [],
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at)!,
  };
}

/** Whether `token` grants `ability` — `*` grants everything. */
export function tokenCan(token: AccessToken, ability: string): boolean {
  return token.abilities.includes('*') || token.abilities.includes(ability);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
