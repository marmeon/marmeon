import { createHash, randomInt } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Clock, ContainerError, durationToSeconds, type Duration } from '@marmeon/core';
import { Connections, sql, type Generated, type JsonColumn, type Secret } from '@marmeon/database';
import { AuthConfig } from './config.ts';
import type { AuthUserId } from './user.ts';
import { withCode } from '@marmeon/core/internal';

/** The table the app's migration creates (`make:auth` writes it) — see {@link AccessTokenTable}. */
export const ACCESS_TOKEN_TABLE = 'personal_access_tokens';

/**
 * The columns {@link DatabaseAccessTokens} needs — the `personal_access_tokens` migration `make:auth` writes into
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

/** The columns readiness waits for on `personal_access_tokens`. */
export const ACCESS_TOKEN_COLUMNS = ['id', 'user_id', 'name', 'token_hash', 'abilities', 'last_used_at', 'expires_at', 'created_at', 'updated_at'] as const satisfies readonly (keyof AccessTokenTable)[];

/** The primary key of a token row: a number in the starter kit's table, a string in one with UUID keys. */
export type AccessTokenId = number | string;

/** What a new token may do and for how long: both are named, so a token never gets everything and forever by accident. */
export interface AccessTokenOptions {
  /** The abilities the token grants (`tokenCan()`, `abilities()`); `['*']` grants everything. */
  readonly abilities: readonly string[];
  /** How long the token works (a {@link Duration}), or `null` for a token that never expires. */
  readonly expiresIn: Duration | null;
}

/** A token as the app sees it — never with its secret. */
export interface AccessToken {
  readonly id: AccessTokenId;
  readonly userId: AuthUserId;
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
 *
 * Your own store extends this class and implements every method; none has a default, and a member added later has one only if it is
 * not security-relevant. See `docs/authentication.md#your-own-stores`.
 */
export abstract class AccessTokenStore {
  /** A mark without meaning: only a subclass fits the type, so a store that merely `implements` this contract does not compile. */
  readonly #contract = true;

  /** Refuses to be built itself: the container builds an unbound abstract key as an empty object, which would fail much later. */
  constructor() {
    if (new.target === AccessTokenStore) throw new ContainerError(withCode('K1', `AccessTokenStore is abstract: bind a store with container.singleton(AccessTokenStore, YourStore).`), { reason: 'unbound', key: 'AccessTokenStore', path: [] });
  }

  /**
   * A new token — the plain text is returned once and never stored. `abilities` and `expiresIn` are required: `['*']` grants everything,
   * `expiresIn: null` never expires. `DatabaseAccessTokens` throws a `TypeError` for options that lack either (untyped callers), before it writes anything.
   * See `docs/api-tokens.md#creating-tokens`.
   */
  abstract create(userId: AuthUserId, name: string, options: AccessTokenOptions): Promise<{ plainText: string; token: AccessToken }>;
  /** The token for a presented plain text — `undefined` for malformed, unknown, wrong, revoked or expired ones, all alike. */
  abstract find(plainText: string): Promise<AccessToken | undefined>;
  /** Notes the use (at most once a minute, not a write per request). */
  abstract touch(token: AccessToken): Promise<void>;
  abstract list(userId: AuthUserId): Promise<AccessToken[]>;
  /** Revokes one token of the user — `false` if the user has no such token. */
  abstract revoke(userId: AuthUserId, id: AccessTokenId): Promise<boolean>;
  /** Revokes every token of the user (a new password with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`) — how many. */
  abstract revokeAll(userId: AuthUserId): Promise<number>;
  /**
   * Deletes the tokens that expired more than `graceSeconds` ago (`marmeon auth:prune-tokens`) — they stop working when
   * they expire, but stay listed until pruned. How many. Tokens without an expiry stay until revoked.
   */
  abstract prune(graceSeconds?: number): Promise<number>;
  /** Revokes the tokens of every user (`AccountSessions.endEveryone()`, unless `accessTokens: false`) — how many. */
  abstract revokeEveryone(): Promise<number>;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
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

/** The default {@link AccessTokenStore}, on the app's `personal_access_tokens` table. */
export class DatabaseAccessTokens extends AccessTokenStore {
  readonly #connections: Connections;
  readonly #prefix: string;
  readonly #clock: Clock;

  /** @internal Built by the container. */
  constructor(connections: Connections, config: AuthConfig, clock: Clock) {
    super();
    this.#connections = connections;
    this.#prefix = config.tokenPrefix;
    this.#clock = clock;
  }

  async create(userId: AuthUserId, name: string, options: AccessTokenOptions) {
    const { abilities, expiresIn } = checkOptions(options);
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
        expires_at: expiresIn === null ? null : new Date(now.getTime() + Math.floor(durationToSeconds(expiresIn)) * 1000),
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

  async list(userId: AuthUserId): Promise<AccessToken[]> {
    const rows = await this.#db()
      .selectFrom(ACCESS_TOKEN_TABLE)
      .select(['id', 'user_id', 'name', 'abilities', 'last_used_at', 'expires_at', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
    return rows.map(toToken);
  }

  async revoke(userId: AuthUserId, id: AccessTokenId): Promise<boolean> {
    const result = await this.#db().deleteFrom(ACCESS_TOKEN_TABLE).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async revokeAll(userId: AuthUserId): Promise<number> {
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

/** Refuses options an untyped caller left out: a token without them would be allowed everything, or live forever. */
function checkOptions(options: unknown): AccessTokenOptions {
  const given = (typeof options === 'object' && options !== null ? options : {}) as Partial<Record<keyof AccessTokenOptions, unknown>>;
  if (!Array.isArray(given.abilities) || !given.abilities.every((ability) => typeof ability === 'string')) {
    throw new TypeError("tokens.create() needs { abilities, expiresIn }: abilities is a list of strings (['*'] grants everything).");
  }
  if (given.expiresIn === undefined) throw new TypeError('tokens.create() needs { abilities, expiresIn }: expiresIn is a Duration, or null for a token that never expires.');
  return given as unknown as AccessTokenOptions;
}

function toToken(row: { id: AccessTokenId; user_id: number | string; name: string; abilities: unknown; last_used_at: string | Date | null; expires_at: string | Date | null; created_at: string | Date }): AccessToken {
  const iso = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());
  return {
    id: row.id,
    userId: row.user_id as AuthUserId,
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
