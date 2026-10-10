import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Clock, token } from '@marmeon/core';
import { Connections, secret, type Generated, type JsonColumn, type Secret } from '@marmeon/database';
import type { Duration } from '@marmeon/http';
import { AuthConfig } from './config.ts';

/** The table the app's migration creates (`make:auth` writes it) — see {@link AccessTokenTable}. */
export const ACCESS_TOKEN_TABLE = 'personal_access_tokens';

/**
 * The columns {@link DatabaseAccessTokens} needs — the `personal_access_tokens` migration `make:auth` writes into
 * `modules/auth/migrations/` creates them (the token only as its SHA-256, a `secret()` column).
 */
export interface AccessTokenTable {
  id: Generated<number>;
  user_id: number | string;
  name: string;
  token_hash: Secret<string>;
  abilities: JsonColumn;
  last_used_at: string | Date | null;
  expires_at: string | Date | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** A token as the app sees it — never with its secret. */
export interface AccessToken {
  readonly id: number;
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
 * Personal access tokens: opaque, `marmeon_<id>|<40 characters><crc32>`. The prefix
 * and the checksum let secret scanners find leaked tokens and let typos fail without a query; only a
 * SHA-256 of the secret is stored — 62⁴⁰ ≈ 2²³⁸ possibilities need no slow hash, and a slow hash per
 * API request would be a lever for anyone sending invalid tokens.
 */
export interface AccessTokenStore {
  /** A new token — the plain text is returned once and never stored. */
  create(userId: number | string, name: string, options?: { abilities?: readonly string[]; expiresIn?: Duration }): Promise<{ plainText: string; token: AccessToken }>;
  /** The token for a presented plain text — `undefined` for malformed, unknown, wrong, revoked or expired ones. */
  find(plainText: string): Promise<AccessToken | undefined>;
  /** Notes the use (at most once a minute, not a write per request). */
  touch(token: AccessToken): Promise<void>;
  list(userId: number | string): Promise<AccessToken[]>;
  /** Revokes one token of the user — `false` if the user has no such token. */
  revoke(userId: number | string, id: number): Promise<boolean>;
  /** Revokes every token of the user (a new password with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`) — how many. */
  revokeAll(userId: number | string): Promise<number>;
  /**
   * Deletes the tokens that expired more than `graceSeconds` ago (`marmeon auth:prune-tokens`) — they stop working when
   * they expire, but stay listed until pruned. How many. Tokens without an expiry stay until revoked.
   */
  prune(graceSeconds?: number): Promise<number>;
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

/** Splits and checks a presented token — without the database. */
export function parseAccessToken(plainText: string, prefix: string): { id: number; secret: string } | undefined {
  if (typeof plainText !== 'string' || !plainText.startsWith(prefix)) return undefined;
  const match = /^(\d{1,15})\|([A-Za-z0-9]{40})([0-9a-f]{8})$/.exec(plainText.slice(prefix.length));
  if (!match) return undefined;
  const [, id, secret, sum] = match as unknown as [string, string, string, string];
  // The checksum covers prefix, id and secret: a typo anywhere fails here, before any query.
  if (checksum(`${prefix}${id}|${secret}`) !== sum) return undefined;
  return { id: Number(id), secret };
}

/** The default {@link AccessTokenStore}, on the app's `personal_access_tokens` table. */
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
        token_hash: sha256(secret),
        abilities: JSON.stringify(abilities),
        last_used_at: null,
        expires_at: expiresIn === undefined ? null : new Date(now.getTime() + seconds(expiresIn) * 1000),
        created_at: now,
        updated_at: now,
      })
      .returning(['id', 'user_id', 'name', 'abilities', 'last_used_at', 'expires_at', 'created_at'])
      .executeTakeFirstOrThrow();
    const body = `${this.#prefix}${row.id}|${secret}`;
    return { plainText: `${body}${checksum(body)}`, token: toToken(row) };
  }

  async find(plainText: string): Promise<AccessToken | undefined> {
    const parsed = parseAccessToken(plainText, this.#prefix);
    if (!parsed) return undefined;
    // Looked up by id; the secret is compared in constant time (never `where token_hash = ?`).
    const row = await this.#db()
      .selectFrom(ACCESS_TOKEN_TABLE)
      .select((eb) => ['id', 'user_id', 'name', secret(eb, 'token_hash'), 'abilities', 'last_used_at', 'expires_at', 'created_at'])
      .where('id', '=', parsed.id)
      .executeTakeFirst();
    if (!row || !equal(sha256(parsed.secret), row.token_hash)) return undefined;
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

  async revoke(userId: number | string, id: number): Promise<boolean> {
    const result = await this.#db().deleteFrom(ACCESS_TOKEN_TABLE).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async revokeAll(userId: number | string): Promise<number> {
    const result = await this.#db().deleteFrom(ACCESS_TOKEN_TABLE).where('user_id', '=', userId).executeTakeFirst();
    return Number(result.numDeletedRows);
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

function toToken(row: { id: number; user_id: number | string; name: string; abilities: unknown; last_used_at: string | Date | null; expires_at: string | Date | null; created_at: string | Date }): AccessToken {
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

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
