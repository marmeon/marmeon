import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Clock, commitAnyway, err, ok, token, type Result } from '@marmeon/core';
import { Connections, secret, sql, type Generated, type Secret } from '@marmeon/database';

/** The table the app's migration creates (`make:auth` writes it) — see {@link RememberTokenTable}. */
export const REMEMBER_TABLE = 'marmeon_remember_tokens';

/**
 * The columns {@link DatabaseRememberTokens} needs — the `marmeon_remember_tokens` migration `make:auth` writes into
 * `modules/auth/migrations/` creates them (the validators only as SHA-256, `secret()` columns).
 */
export interface RememberTokenTable {
  id: Generated<number>;
  user_id: number | string;
  selector: string;
  validator_hash: Secret<string>;
  previous_validator_hash: Secret<string | null>;
  rotated_at: string | Date | null;
  last_used_at: string | Date | null;
  expires_at: string | Date;
  /** The fingerprint of the account state the token was issued under (`NULL` in rows from before the column existed: they are refused). */
  account_fingerprint: string | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** The columns readiness waits for on `marmeon_remember_tokens`. */
export const REMEMBER_COLUMNS = ['id', 'user_id', 'selector', 'validator_hash', 'previous_validator_hash', 'rotated_at', 'last_used_at', 'expires_at', 'account_fingerprint', 'created_at', 'updated_at'] as const satisfies readonly (keyof RememberTokenTable)[];

/** What a valid remember-me cookie proved: the user, and the rotated cookie value — `undefined` when a concurrent request already rotated it. */
export interface RememberedDevice {
  readonly userId: number | string;
  readonly cookie: string | undefined;
  readonly expiresAt: Date;
  /**
   * When the token was made (rotation keeps it), on the same clock as `confirmed_at` of the second factor and with its time zone — a
   * database default without a zone would compare wrongly. A token made before (or in the same millisecond as) the account's
   * second factor never proved one, and is refused.
   */
  readonly createdAt: Date;
  /**
   * The fingerprint the token was created with (rotation keeps it), `undefined` for a token that has none. `Auth` signs a device in only
   * when it equals the account's present fingerprint; a token without one is refused.
   */
  readonly fingerprint: string | undefined;
}

/**
 * Why a remember-me cookie did not sign anyone in. `invalid` covers unknown, malformed and expired tokens alike;
 * `stolen` means an old validator came back after rotation: the cookie was copied, and every token of the user is gone now.
 * `Auth` then ends the user's sessions too (`AccountSessions.end()`), the one the copy already signed in included.
 */
export type RememberTokenError =
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'stolen';
      readonly userId: number | string;
      /** The presented validator was the one just replaced by a rotation. Information only: an older validator or one never issued, on a known selector, comes from someone who held the cookie (the selector is random), and `Auth` announces every `stolen` the same way. */
      readonly reused?: boolean;
    };

/**
 * Remember-me tokens, one per device: `<selector>.<validator>` in the cookie, the selector in
 * clear (to find the row), the validator only as SHA-256 (the cookie is the secret, the database
 * is not). Every use rotates the validator; an old one coming back means the cookie was copied, so
 * all of the user's tokens are dropped. The selector stays the same over every rotation: it names the device (the sign-ins list hangs on it).
 */
export interface RememberTokenStore {
  /**
   * A new token for `userId`; returns the cookie value. `fingerprint` is the account state the sign-in verified (a SHA-256, safe to
   * store): persist it with the token and hand it back from `consume()`. A store that drops it makes every cookie useless.
   */
  create(userId: number | string, expiresAt: Date, fingerprint: string): Promise<string>;
  /** Checks a cookie value and rotates it — an `err` for unknown, malformed or expired tokens (`invalid`) and for a copied cookie (`stolen`). Deleting every token of the account and choosing the one request that reports `stolen` must be one atomic step: a failed statement deletes nothing, so the next replay reports it again. The revocation of a `stolen` token and the deletion of an expired one must commit even inside a transaction that returns the err (`commitAnyway`). */
  consume(cookie: string): Promise<Result<RememberedDevice, RememberTokenError>>;
  /**
   * Whether the token of this cookie is still stored (found by its selector, the validator is not checked); `false` for a
   * malformed cookie. It must see a `forgetUser()` at once (read-after-write: no cache, no lagging replica): an answer of `true` for a forgotten token lets a session survive `AccountSessions.end()`. A sign-in asks it right before it starts, to notice that `end()` took the token meanwhile.
   */
  exists(cookie: string): Promise<boolean>;
  /** Drops the token of this cookie (sign-out on this device). */
  forget(cookie: string): Promise<void>;
  /**
   * Replaces the fingerprint of the token of this cookie, if it belongs to `userId` and the cookie carries the row's current validator
   * (or the previous one inside the grace window, as `consume()` accepts) — for the device that stays signed in when `auth.updateSessionKey()` or
   * `logoutOtherDevices()` changes the account on purpose. Optional: without it that device's cookie is refused later and the user signs in again.
   */
  rebind?(userId: number | string, cookie: string, fingerprint: string): Promise<Result<void, RememberTokenError>>;
  /** Drops every token of the user — except the one of `except` (the current device). */
  forgetUser(userId: number | string, except?: string): Promise<void>;
  /**
   * Deletes every expired token and every token made `maxAgeDays` days ago or earlier (`marmeon auth:prune-tokens`, with
   * `AUTH_REMEMBER_DAYS`): a lookup drops only the one it finds, and a lowered or zeroed setting must not leave tokens that a
   * raised one would revive. `0` deletes every token. How many.
   */
  prune(maxAgeDays: number): Promise<number>;
  /** Deletes every token, whatever its age or expiry (`AccountSessions.endEveryone()`, which refuses a store without it). How many. */
  forgetEveryone?(): Promise<number>;
}
export const RememberTokenStore = token<RememberTokenStore>('RememberTokenStore');

const SELECTOR = /^[A-Za-z0-9_-]{22}$/;
const VALIDATOR = /^[A-Za-z0-9_-]{43}$/;
/**
 * A request racing the rotation (two tabs of one page) may still present the previous validator this long. Short on purpose: a copy of
 * the cookie from before the rotation signs in unnoticed for as long as this lasts.
 */
const GRACE_MS = 10_000;

/** The default {@link RememberTokenStore}, on the app's `marmeon_remember_tokens` table. */
export class DatabaseRememberTokens implements RememberTokenStore {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  async create(userId: number | string, expiresAt: Date, fingerprint: string): Promise<string> {
    const selector = randomBytes(16).toString('base64url');
    const validator = randomBytes(32).toString('base64url');
    const now = new Date(this.#clock.now());
    await this.#db()
      .insertInto(REMEMBER_TABLE)
      .values({ user_id: userId, selector, validator_hash: sha256(validator), account_fingerprint: fingerprint, expires_at: expiresAt, created_at: now, updated_at: now })
      .execute();
    return `${selector}.${validator}`;
  }

  async consume(cookie: string): Promise<Result<RememberedDevice, RememberTokenError>> {
    const parts = parse(cookie);
    if (!parts) return err({ kind: 'invalid' }); // malformed: no query
    const db = this.#db();
    const row = await db
      .selectFrom(REMEMBER_TABLE)
      .select((eb) => ['id', 'user_id', secret(eb, 'validator_hash'), secret(eb, 'previous_validator_hash'), 'rotated_at', 'expires_at', 'created_at', 'account_fingerprint'])
      .where('selector', '=', parts.selector)
      .executeTakeFirst();
    if (!row) return err({ kind: 'invalid' });
    const expiresAt = new Date(row.expires_at);
    // `!(a > b)`: an unreadable time counts as expired.
    if (!(expiresAt.getTime() > this.#clock.now())) {
      await db.deleteFrom(REMEMBER_TABLE).where('id', '=', row.id).execute();
      return commitAnyway(err({ kind: 'invalid' })); // the delete stays when an ambient transaction would roll back an err
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
        .where(sql<boolean>`${sql.ref('validator_hash')} = ${row.validator_hash}`)
        .executeTakeFirst();
      const rotated = result.numUpdatedRows > 0n;
      return ok({ userId: row.user_id, cookie: rotated ? `${parts.selector}.${validator}` : undefined, expiresAt, createdAt: new Date(row.created_at), fingerprint: row.account_fingerprint ?? undefined });
    }
    const rotatedAt = row.rotated_at === null ? 0 : new Date(row.rotated_at).getTime();
    if (row.previous_validator_hash !== null && equal(presented, row.previous_validator_hash) && this.#clock.now() - rotatedAt < GRACE_MS) {
      return ok({ userId: row.user_id, cookie: undefined, expiresAt, createdAt: new Date(row.created_at), fingerprint: row.account_fingerprint ?? undefined }); // the other tab's response carries the new cookie
    }
    // A validator that is neither current nor just rotated: someone else used this cookie first. Deleting every token of the account
    // and deciding who reports it are one statement: if it fails, nothing is deleted and the next replay starts over. Only the
    // request whose statement removed this row reports; parallel replays find it gone and are plain invalid ones, so the owner is
    // told once. No `outsideTransaction()`: SQLite has one connection.
    const removed = await db.deleteFrom(REMEMBER_TABLE).where('user_id', '=', row.user_id).returning('id').execute();
    if (!removed.some((token) => token.id === row.id)) return commitAnyway(err({ kind: 'invalid' }));
    const reused = row.previous_validator_hash !== null && equal(presented, row.previous_validator_hash);
    // The revocation must survive an ambient transaction that would roll back on an err.
    return commitAnyway(err({ kind: 'stolen', userId: row.user_id, reused }));
  }

  async exists(cookie: string): Promise<boolean> {
    const parts = parse(cookie);
    if (!parts) return false;
    const row = await this.#db().selectFrom(REMEMBER_TABLE).select('selector').where('selector', '=', parts.selector).executeTakeFirst();
    return row !== undefined;
  }

  async rebind(userId: number | string, cookie: string, fingerprint: string): Promise<Result<void, RememberTokenError>> {
    const parts = parse(cookie);
    if (!parts) return err({ kind: 'invalid' });
    const db = this.#db();
    // Scoped to the user: a cookie of another account's device is never re-stamped for this one.
    const row = await db
      .selectFrom(REMEMBER_TABLE)
      .select((eb) => ['id', 'user_id', secret(eb, 'validator_hash'), secret(eb, 'previous_validator_hash'), 'rotated_at', 'expires_at'])
      .where('selector', '=', parts.selector)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row || !(new Date(row.expires_at).getTime() > this.#clock.now())) return err({ kind: 'invalid' });
    const presented = sha256(parts.validator);
    const rotatedAt = row.rotated_at === null ? 0 : new Date(row.rotated_at).getTime();
    const current = equal(presented, row.validator_hash);
    const previous = row.previous_validator_hash !== null && equal(presented, row.previous_validator_hash);
    if (current || (previous && this.#clock.now() - rotatedAt < GRACE_MS)) {
      // Only the row whose validator is still the one that was checked: a rotation in between leaves it unstamped (refused later).
      const result = await db
        .updateTable(REMEMBER_TABLE)
        .set({ account_fingerprint: fingerprint })
        .where('id', '=', row.id)
        .where('user_id', '=', userId)
        .where(sql<boolean>`${sql.ref('validator_hash')} = ${row.validator_hash}`)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n ? ok() : err({ kind: 'invalid' });
    }
    // A validator that is neither current nor just rotated: someone else holds a newer cookie of this token — the copy `consume()` reports.
    const removed = await db.deleteFrom(REMEMBER_TABLE).where('id', '=', row.id).executeTakeFirst();
    if (removed.numDeletedRows === 0n) return commitAnyway(err({ kind: 'invalid' }));
    await this.forgetUser(row.user_id);
    return commitAnyway(err({ kind: 'stolen', userId: row.user_id, reused: previous }));
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

  async forgetEveryone(): Promise<number> {
    return Number((await this.#db().deleteFrom(REMEMBER_TABLE).executeTakeFirst()).numDeletedRows);
  }

  async prune(maxAgeDays: number): Promise<number> {
    const now = this.#clock.now();
    const result = await this.#db()
      .deleteFrom(REMEMBER_TABLE)
      .where((eb) => eb.or([eb('expires_at', '<=', new Date(now)), eb('created_at', '<=', new Date(now - maxAgeDays * 86_400_000))]))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #db() {
    return this.#connections.get<{ [REMEMBER_TABLE]: RememberTokenTable }>();
  }
}

/** The selector of a `<selector>.<validator>` cookie value — the part that stays the same over rotations. */
export function selectorOf(cookie: string): string {
  return cookie.split('.')[0]!;
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
