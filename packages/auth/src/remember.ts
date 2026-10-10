import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Clock, token } from '@marmeon/core';
import { Connections, type Generated } from '@marmeon/database';

/** The table the app's migration creates (`make:auth` writes it) — see {@link RememberTokenTable}. */
export const REMEMBER_TABLE = 'remember_tokens';

/**
 * The columns {@link DatabaseRememberTokens} needs — the `remember_tokens` migration `make:auth` writes into
 * `modules/auth/migrations/` creates them (the validators only as SHA-256, `secret()` columns).
 */
export interface RememberTokenTable {
  id: Generated<number>;
  user_id: number | string;
  selector: string;
  validator_hash: string;
  previous_validator_hash: string | null;
  rotated_at: string | Date | null;
  last_used_at: string | Date | null;
  expires_at: string | Date;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** What a remember-me cookie proved. */
export type RememberResult =
  /** Valid: the user, and the rotated cookie value — `undefined` when a concurrent request already rotated it. */
  | { readonly kind: 'valid'; readonly userId: number | string; readonly cookie: string | undefined; readonly expiresAt: Date }
  /** An old validator came back after rotation: the cookie was copied. Every token of the user is gone now. */
  | { readonly kind: 'stolen'; readonly userId: number | string };

/**
 * Remember-me tokens, one per device: `<selector>.<validator>` in the cookie, the selector in
 * clear (to find the row), the validator only as SHA-256 (the cookie is the secret, the database
 * is not). Every use rotates the validator; an old one coming back means the cookie was copied, so
 * all of the user's tokens are dropped.
 */
export interface RememberTokenStore {
  /** A new token for `userId`; returns the cookie value. */
  create(userId: number | string, expiresAt: Date): Promise<string>;
  /** Checks a cookie value and rotates it — `undefined` for unknown, malformed or expired tokens. */
  consume(cookie: string): Promise<RememberResult | undefined>;
  /** Drops the token of this cookie (sign-out on this device). */
  forget(cookie: string): Promise<void>;
  /** Drops every token of the user — except the one of `except` (the current device). */
  forgetUser(userId: number | string, except?: string): Promise<void>;
  /** Deletes every expired token (`marmeon auth:prune-tokens`) — a lookup drops only the one it finds. How many. */
  prune(): Promise<number>;
}
export const RememberTokenStore = token<RememberTokenStore>('RememberTokenStore');

const SELECTOR = /^[A-Za-z0-9_-]{22}$/;
const VALIDATOR = /^[A-Za-z0-9_-]{43}$/;
/** A request racing the rotation (two tabs at once) may still present the previous validator this long. */
const GRACE_MS = 60_000;

/** The default {@link RememberTokenStore}, on the app's `remember_tokens` table. */
export class DatabaseRememberTokens implements RememberTokenStore {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  async create(userId: number | string, expiresAt: Date): Promise<string> {
    const selector = randomBytes(16).toString('base64url');
    const validator = randomBytes(32).toString('base64url');
    const now = new Date(this.#clock.now());
    await this.#db()
      .insertInto(REMEMBER_TABLE)
      .values({ user_id: userId, selector, validator_hash: sha256(validator), expires_at: expiresAt, created_at: now, updated_at: now })
      .execute();
    return `${selector}.${validator}`;
  }

  async consume(cookie: string): Promise<RememberResult | undefined> {
    const parts = parse(cookie);
    if (!parts) return undefined; // malformed: no query
    const db = this.#db();
    const row = await db
      .selectFrom(REMEMBER_TABLE)
      .select(['id', 'user_id', 'validator_hash', 'previous_validator_hash', 'rotated_at', 'expires_at'])
      .where('selector', '=', parts.selector)
      .executeTakeFirst();
    if (!row) return undefined;
    const expiresAt = new Date(row.expires_at);
    if (expiresAt.getTime() <= this.#clock.now()) {
      await db.deleteFrom(REMEMBER_TABLE).where('id', '=', row.id).execute();
      return undefined;
    }

    const presented = sha256(parts.validator);
    if (equal(presented, row.validator_hash)) {
      const validator = randomBytes(32).toString('base64url');
      const now = new Date(this.#clock.now());
      // Only if nobody rotated in between — a concurrent request with the same cookie is not a theft.
      const result = await db
        .updateTable(REMEMBER_TABLE)
        .set({ validator_hash: sha256(validator), previous_validator_hash: row.validator_hash, rotated_at: now, last_used_at: now, updated_at: now })
        .where('id', '=', row.id)
        .where('validator_hash', '=', row.validator_hash)
        .executeTakeFirst();
      const rotated = result.numUpdatedRows > 0n;
      return { kind: 'valid', userId: row.user_id, cookie: rotated ? `${parts.selector}.${validator}` : undefined, expiresAt };
    }
    const rotatedAt = row.rotated_at === null ? 0 : new Date(row.rotated_at).getTime();
    if (row.previous_validator_hash !== null && equal(presented, row.previous_validator_hash) && this.#clock.now() - rotatedAt < GRACE_MS) {
      return { kind: 'valid', userId: row.user_id, cookie: undefined, expiresAt }; // the other tab's response carries the new cookie
    }
    // A validator that is neither current nor just rotated: someone else used this cookie first.
    await this.forgetUser(row.user_id);
    return { kind: 'stolen', userId: row.user_id };
  }

  async forget(cookie: string): Promise<void> {
    const parts = parse(cookie);
    if (parts) await this.#db().deleteFrom(REMEMBER_TABLE).where('selector', '=', parts.selector).execute();
  }

  async forgetUser(userId: number | string, except?: string): Promise<void> {
    let query = this.#db().deleteFrom(REMEMBER_TABLE).where('user_id', '=', userId);
    const keep = except === undefined ? undefined : parse(except);
    if (keep) query = query.where('selector', '!=', keep.selector);
    await query.execute();
  }

  async prune(): Promise<number> {
    const result = await this.#db().deleteFrom(REMEMBER_TABLE).where('expires_at', '<=', new Date(this.#clock.now())).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #db() {
    return this.#connections.get<{ [REMEMBER_TABLE]: RememberTokenTable }>();
  }
}

function parse(cookie: string): { selector: string; validator: string } | undefined {
  const [selector, validator, ...rest] = cookie.split('.');
  if (rest.length || !selector || !validator || !SELECTOR.test(selector) || !VALIDATOR.test(validator)) return undefined;
  return { selector, validator };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
