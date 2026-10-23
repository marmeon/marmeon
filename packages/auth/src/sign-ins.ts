import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Clock, commitAnyway, ContainerError, err, ok, type Result } from '@marmeon/core';
import { Connections, secret, sql, type Generated, type Secret } from '@marmeon/database';
import type { DeviceDescription } from './device.ts';
import type { AuthUserId } from './user.ts';
import { withCode } from '@marmeon/core/internal';

/** The table the app's migration creates (`marmeon make:sign-ins-table` writes it) — see {@link SignInsTable}. */
export const SIGN_INS_TABLE = 'sign_ins';

/**
 * The columns {@link DatabaseSignIns} needs. A row is one sign-in of one browser and the authority over it: the session
 * carries only the row's id, and a session whose row is gone ends. No IP address is stored.
 */
export interface SignInsTable {
  id: string;
  user_id: number | string;
  user_agent: string | null;
  /** The part of the remember-me cookie that finds the row. Whoever knows it can end the sign-in, so it is a secret as well. */
  remember_selector: Secret<string | null>;
  remember_until: string | Date | null;
  /** The validator of the remember-me cookie, only as SHA-256 — the cookie is the secret, the database is not. */
  remember_validator_hash: Secret<string | null>;
  /** The validator a rotation replaced; it is taken for a few seconds after the rotation. */
  remember_previous_validator_hash: Secret<string | null>;
  remember_rotated_at: string | Date | null;
  remember_created_at: string | Date | null;
  /** The fingerprint of the account state the token was issued under. */
  remember_fingerprint: string | null;
  signed_in_at: string | Date;
  last_seen_at: string | Date;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** The columns readiness waits for on `sign_ins`. */
export const SIGN_INS_COLUMNS = [
  'id',
  'user_id',
  'user_agent',
  'remember_selector',
  'remember_until',
  'remember_validator_hash',
  'remember_previous_validator_hash',
  'remember_rotated_at',
  'remember_created_at',
  'remember_fingerprint',
  'signed_in_at',
  'last_seen_at',
  'created_at',
  'updated_at',
] as const satisfies readonly (keyof SignInsTable)[];

/** One of the browsers a user is signed in on, as `auth.signIns()` lists it. */
export interface SignIn {
  readonly id: string;
  /** The sign-in of the request that asks. */
  readonly current: boolean;
  /** Whether a remember-me cookie keeps this browser signed in. */
  readonly remembered: boolean;
  readonly signedInAt: Date;
  /** Written at most every {@link SEEN_GRANULARITY_SECONDS} seconds. */
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  /** The browser's `User-Agent`, cut to 255 characters. */
  readonly userAgent: string | undefined;
  /** What `describeDevice()` makes of it — structured, so an app words it in its own language. */
  readonly device: DeviceDescription;
}

/** A sign-in as listed to its user. */
export interface SignInRecord {
  readonly id: string;
  readonly userId: AuthUserId;
  /** The browser's `User-Agent`, cut to 255 characters; feed it to `describeDevice()`. */
  readonly userAgent: string | undefined;
  /** Whether a remember-me cookie keeps this browser signed in. */
  readonly remembered: boolean;
  readonly signedInAt: Date;
  /** Written at most every {@link SEEN_GRANULARITY_SECONDS} seconds. */
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
}

/** What a valid remember-me cookie proved: the user, the sign-in it belongs to, and the rotated cookie value — `undefined` when a concurrent request already rotated it. */
export interface RememberedDevice {
  readonly userId: AuthUserId;
  /** The id of the sign-in row the token hangs on. */
  readonly signIn: string;
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
      readonly userId: AuthUserId;
      /** The presented validator was the one just replaced by a rotation. Information only: an older validator or one never issued, on a known selector, comes from someone who held the cookie (the selector is random), and `Auth` announces every `stolen` the same way. */
      readonly reused?: boolean;
    };

/** How long a session may idle and how long it may last at all (`SESSION_LIFETIME_MINUTES`, `AUTH_SESSION_MAX_HOURS`), in seconds — what makes a row alive. */
export interface SignInWindow {
  readonly idleSeconds: number;
  readonly maxSeconds: number;
}

/**
 * The sign-ins of the app's users, one row per browser, and the remember-me token that keeps a browser signed in. Every app with a
 * `UserProvider` has them: `DatabaseSignIns` on the `sign_ins` table (`marmeon make:sign-ins-table` writes it). Every method that takes
 * an id first checks its shape and asks nothing for a malformed one; every query names the user, or the selector of a cookie.
 *
 * Your own store extends this class and implements every method; none has a default, and a member added later has one only if it is
 * not security-relevant. See `docs/authentication.md#your-own-stores`.
 */
export abstract class SignInStore {
  /** A mark without meaning: only a subclass fits the type, so a store that merely `implements` this contract does not compile. */
  readonly #contract = true;

  /** Refuses to be built itself: the container builds an unbound abstract key as an empty object, which would fail much later. */
  constructor() {
    if (new.target === SignInStore) throw new ContainerError(withCode('K1', `SignInStore is abstract: bind a store with container.singleton(SignInStore, YourStore).`), { reason: 'unbound', key: 'SignInStore', path: [] });
  }

  /** A new sign-in, without a remember-me token; returns its id (128 random bits, base64url). */
  abstract create(input: { userId: AuthUserId; userAgent: string | undefined }): Promise<string>;
  /** Whether the sign-in still exists; with `touch`, also writes `last_seen_at` when it is older than {@link SEEN_GRANULARITY_SECONDS}. Never creates one. */
  abstract seen(userId: AuthUserId, id: string, touch: boolean): Promise<boolean>;
  /** The user's living sign-ins, the most recently seen first. */
  abstract list(userId: AuthUserId, window: SignInWindow): Promise<readonly SignInRecord[]>;
  /** Deletes one sign-in of the user, token included; `false` when there is none (another user's id is none). */
  abstract end(userId: AuthUserId, id: string): Promise<boolean>;
  /** Deletes every sign-in of the user, tokens included, except the one with the id `except`; how many. */
  abstract endAll(userId: AuthUserId, except?: string): Promise<number>;
  /** Deletes every sign-in of every user, tokens included; how many. */
  abstract endEveryone(): Promise<number>;
  /**
   * Deletes exactly the rows `list` does not show, of every user; how many. It first takes the token off every row whose token has
   * expired or was made `rememberMaxAgeDays` days ago or earlier (`AUTH_REMEMBER_DAYS`; the row stays while its session lives): a
   * lowered or zeroed setting must not leave tokens that a raised one would revive. `0` takes every token off.
   */
  abstract prune(window: SignInWindow, rememberMaxAgeDays: number): Promise<number>;

  /**
   * Hangs a new remember-me token on the sign-in, replacing the one it has; returns the cookie value `<selector>.<validator>`. `fingerprint`
   * is the account state the sign-in verified (a SHA-256, safe to store): persist it with the token and hand it back from `consume()`. A
   * store that drops it makes every cookie useless. Throws when the user has no such sign-in — nothing is written, no cookie exists.
   */
  abstract issueToken(userId: AuthUserId, id: string, token: { until: Date; fingerprint: string }): Promise<string>;
  /** Takes the token off the sign-in; the row stays. Another user's id changes nothing. */
  abstract dropToken(userId: AuthUserId, id: string): Promise<void>;
  /**
   * Checks a cookie value and rotates it — an `err` for unknown, malformed or expired tokens (`invalid`) and for a copied cookie (`stolen`).
   * Deleting every sign-in of the account and choosing the one request that reports `stolen` must be one atomic step: a failed statement
   * deletes nothing, so the next replay reports it again. The revocation of a `stolen` token and the removal of an expired one must
   * commit even inside a transaction that returns the err (`commitAnyway`).
   */
  abstract consume(cookie: string): Promise<Result<RememberedDevice, RememberTokenError>>;
  /**
   * Whether the sign-in of this cookie still holds its token (found by its selector, the validator is not checked); `false` for a malformed
   * cookie. It must see an `end()` at once (read-after-write: no cache, no lagging replica): an answer of `true` for an ended sign-in
   * lets a session survive `AccountSessions.end()`.
   */
  abstract remembered(cookie: string): Promise<boolean>;
  /**
   * Ends the sign-in of this cookie, token and row (sign-out on this device). A malformed or unknown cookie deletes nothing. It deletes by
   * the selector alone: the selector is as secret as the cookie, and whoever knows it can do more through `consume()`; a check of the
   * validator would keep a sign-out with a stale cookie from ending the sign-in.
   */
  abstract forgetToken(cookie: string): Promise<void>;
  /**
   * Replaces the fingerprint of the token of this cookie, if it belongs to `userId` and the cookie carries the row's current validator
   * (or the previous one inside the grace window, as `consume()` accepts) — for the device that stays signed in when
   * `auth.updateSessionKey()` changes the account on purpose.
   */
  abstract rebind(userId: AuthUserId, cookie: string, fingerprint: string): Promise<Result<void, RememberTokenError>>;
}

/** `last_seen_at` is written at most this often — no write per request, and a coarse time is all a list needs. */
export const SEEN_GRANULARITY_SECONDS = 300;

const ID = /^[A-Za-z0-9_-]{22}$/;
const SELECTOR = /^[A-Za-z0-9_-]{22}$/;
const VALIDATOR = /^[A-Za-z0-9_-]{43}$/;
/**
 * A request racing the rotation (two tabs of one page) may still present the previous validator this long. Short on purpose: a copy of
 * the cookie from before the rotation signs in unnoticed for as long as this lasts.
 */
const GRACE_MS = 10_000;
/** The columns of the remember-me token: set to these, a row has none. */
const NO_TOKEN = {
  remember_selector: null,
  remember_until: null,
  remember_validator_hash: null,
  remember_previous_validator_hash: null,
  remember_rotated_at: null,
  remember_created_at: null,
  remember_fingerprint: null,
} as const;
const USER_AGENT_LENGTH = 255;

/** The default {@link SignInStore}, on the app's `sign_ins` table. */
export class DatabaseSignIns extends SignInStore {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    super();
    this.#connections = connections;
    this.#clock = clock;
  }

  async create(input: { userId: AuthUserId; userAgent: string | undefined }): Promise<string> {
    const id = randomBytes(16).toString('base64url');
    const now = this.#now();
    await this.#db()
      .insertInto(SIGN_INS_TABLE)
      .values({ id, user_id: input.userId, user_agent: cleanUserAgent(input.userAgent), signed_in_at: now, last_seen_at: now, created_at: now, updated_at: now })
      .execute();
    return id;
  }

  async seen(userId: AuthUserId, id: string, touch: boolean): Promise<boolean> {
    if (!ID.test(id)) return false;
    const db = this.#db();
    const row = await db.selectFrom(SIGN_INS_TABLE).select('last_seen_at').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!row) return false;
    if (touch) {
      const now = this.#now();
      // `!(a > b)`: an unreadable time counts as old and is rewritten.
      if (!(new Date(row.last_seen_at).getTime() > now.getTime() - SEEN_GRANULARITY_SECONDS * 1000)) {
        await db.updateTable(SIGN_INS_TABLE).set({ last_seen_at: now, updated_at: now }).where('id', '=', id).where('user_id', '=', userId).execute();
      }
    }
    return true;
  }

  async list(userId: AuthUserId, window: SignInWindow): Promise<readonly SignInRecord[]> {
    const now = this.#clock.now();
    const rows = await this.#db()
      .selectFrom(SIGN_INS_TABLE)
      .select(['id', 'user_id', 'user_agent', 'remember_until', 'signed_in_at', 'last_seen_at', 'created_at'])
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.or([
          eb('remember_until', '>', new Date(now)),
          eb.and([eb('last_seen_at', '>', lastSeenLimit(now, window)), eb('signed_in_at', '>', signedInLimit(now, window))]),
        ]),
      )
      .orderBy('last_seen_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id as AuthUserId,
      userAgent: row.user_agent ?? undefined,
      remembered: row.remember_until !== null && new Date(row.remember_until).getTime() > now,
      signedInAt: new Date(row.signed_in_at),
      lastSeenAt: new Date(row.last_seen_at),
      createdAt: new Date(row.created_at),
    }));
  }

  async end(userId: AuthUserId, id: string): Promise<boolean> {
    if (!ID.test(id)) return false;
    const result = await this.#db().deleteFrom(SIGN_INS_TABLE).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async endAll(userId: AuthUserId, except?: string): Promise<number> {
    let query = this.#db().deleteFrom(SIGN_INS_TABLE).where('user_id', '=', userId);
    if (except !== undefined && ID.test(except)) query = query.where('id', '!=', except);
    return Number((await query.executeTakeFirst()).numDeletedRows);
  }

  async endEveryone(): Promise<number> {
    return Number((await this.#db().deleteFrom(SIGN_INS_TABLE).executeTakeFirst()).numDeletedRows);
  }

  async prune(window: SignInWindow, rememberMaxAgeDays: number): Promise<number> {
    const now = this.#clock.now();
    await this.#db()
      .updateTable(SIGN_INS_TABLE)
      .set({ ...NO_TOKEN, updated_at: new Date(now) })
      .where(sql<boolean>`${sql.ref('remember_selector')} is not null`)
      .where((eb) => eb.or([eb('remember_until', '<=', new Date(now)), eb('remember_created_at', '<=', new Date(now - rememberMaxAgeDays * 86_400_000))]))
      .execute();
    const result = await this.#db()
      .deleteFrom(SIGN_INS_TABLE)
      // Written positively, not as `not(alive)`: a null `remember_until` would make that null, and the row would stay.
      .where((eb) =>
        eb.and([
          eb.or([eb('remember_until', 'is', null), eb('remember_until', '<=', new Date(now))]),
          eb.or([eb('last_seen_at', '<=', lastSeenLimit(now, window)), eb('signed_in_at', '<=', signedInLimit(now, window))]),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async issueToken(userId: AuthUserId, id: string, token: { until: Date; fingerprint: string }): Promise<string> {
    const selector = randomBytes(16).toString('base64url');
    const validator = randomBytes(32).toString('base64url');
    const now = this.#now();
    // Named by id and user: a sign-in of another account never gets a token, and a cookie is handed out only for a row that holds it.
    const result = ID.test(id)
      ? await this.#db()
          .updateTable(SIGN_INS_TABLE)
          .set({
            remember_selector: selector,
            remember_until: token.until,
            remember_validator_hash: sha256(validator),
            remember_previous_validator_hash: null,
            remember_rotated_at: null,
            remember_created_at: now,
            remember_fingerprint: token.fingerprint,
            updated_at: now,
          })
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst()
      : undefined;
    if (!result || result.numUpdatedRows === 0n) throw new Error('auth: cannot issue a remember-me token: the user has no such sign-in.');
    return `${selector}.${validator}`;
  }

  async dropToken(userId: AuthUserId, id: string): Promise<void> {
    if (!ID.test(id)) return;
    await this.#db()
      .updateTable(SIGN_INS_TABLE)
      .set({ ...NO_TOKEN, updated_at: this.#now() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }

  async consume(cookie: string): Promise<Result<RememberedDevice, RememberTokenError>> {
    const parts = parseCookie(cookie);
    if (!parts) return err({ kind: 'invalid' }); // malformed: no query
    const db = this.#db();
    const row = await db
      .selectFrom(SIGN_INS_TABLE)
      .select((eb) => [
        'id',
        'user_id',
        secret(eb, 'remember_validator_hash'),
        secret(eb, 'remember_previous_validator_hash'),
        'remember_rotated_at',
        'remember_until',
        'remember_created_at',
        'remember_fingerprint',
      ])
      .where(selectorIs(parts.selector))
      .executeTakeFirst();
    // A row with a selector but no validator was not made by `issueToken()`: no cookie can match it.
    if (!row || row.remember_validator_hash === null || row.remember_created_at === null) return err({ kind: 'invalid' });
    const expiresAt = new Date(row.remember_until ?? 0);
    // `!(a > b)`: an unreadable time counts as expired.
    if (!(expiresAt.getTime() > this.#clock.now())) {
      // Only the token goes: the row is the sign-in, which lives by its own session.
      await db.updateTable(SIGN_INS_TABLE).set({ ...NO_TOKEN, updated_at: this.#now() }).where('id', '=', row.id).where(selectorIs(parts.selector)).execute();
      return commitAnyway(err({ kind: 'invalid' })); // the update stays when an ambient transaction would roll back an err
    }

    const createdAt = new Date(row.remember_created_at);
    const device = (rotated: string | undefined): Result<RememberedDevice, RememberTokenError> =>
      ok({ userId: row.user_id as AuthUserId, signIn: row.id, cookie: rotated, expiresAt, createdAt, fingerprint: row.remember_fingerprint ?? undefined });
    const presented = sha256(parts.validator);
    if (equal(presented, row.remember_validator_hash)) {
      const validator = randomBytes(32).toString('base64url');
      const now = this.#now();
      // Only if nobody rotated in between — a concurrent request with the same cookie is not a theft. `signed_in_at` moves with it: a
      // remembered browser that comes back is a sign-in that starts now, as the session window counts it.
      const result = await db
        .updateTable(SIGN_INS_TABLE)
        .set({ remember_validator_hash: sha256(validator), remember_previous_validator_hash: row.remember_validator_hash, remember_rotated_at: now, signed_in_at: now, last_seen_at: now, updated_at: now })
        .where('id', '=', row.id)
        .where(sql<boolean>`${sql.ref('remember_validator_hash')} = ${row.remember_validator_hash}`)
        .executeTakeFirst();
      if (result.numUpdatedRows > 0n) return device(`${parts.selector}.${validator}`);
      // The row changed after it was read: a rotation by another request, or a revocation, an end, a new token. Only a cookie that is the
      // row's previous validator now — the other tab's — still signs in; anything else finds no token.
      const current = await db
        .selectFrom(SIGN_INS_TABLE)
        .select((eb) => [secret(eb, 'remember_previous_validator_hash'), 'remember_rotated_at', 'remember_until', 'remember_created_at', 'remember_fingerprint'])
        .where('id', '=', row.id)
        .where(selectorIs(parts.selector))
        .executeTakeFirst();
      if (!current || current.remember_previous_validator_hash === null || !equal(presented, current.remember_previous_validator_hash) || current.remember_rotated_at === null || current.remember_created_at === null) return err({ kind: 'invalid' });
      const freshUntil = new Date(current.remember_until ?? 0);
      if (!(this.#clock.now() - new Date(current.remember_rotated_at).getTime() < GRACE_MS && freshUntil.getTime() > this.#clock.now())) return err({ kind: 'invalid' });
      // What the row says now, not what the first read said: the token may have been re-stamped meanwhile.
      return ok({ userId: row.user_id as AuthUserId, signIn: row.id, cookie: undefined, expiresAt: freshUntil, createdAt: new Date(current.remember_created_at), fingerprint: current.remember_fingerprint ?? undefined });
    }
    const rotatedAt = row.remember_rotated_at === null ? 0 : new Date(row.remember_rotated_at).getTime();
    const previous = row.remember_previous_validator_hash !== null && equal(presented, row.remember_previous_validator_hash);
    if (previous && this.#clock.now() - rotatedAt < GRACE_MS) return device(undefined); // the other tab's response carries the new cookie
    // A validator that is neither current nor just rotated: someone else used this cookie first. Deleting every sign-in of the account
    // and deciding who reports it are one statement: if it fails, nothing is deleted and the next replay starts over. Only the
    // request whose statement removed this row reports; parallel replays find it gone and are plain invalid ones, so the owner is
    // told once. No `outsideTransaction()`: SQLite has one connection.
    const removed = await db.deleteFrom(SIGN_INS_TABLE).where('user_id', '=', row.user_id).returning('id').execute();
    if (!removed.some((signIn) => signIn.id === row.id)) return commitAnyway(err({ kind: 'invalid' }));
    // The revocation must survive an ambient transaction that would roll back on an err.
    return commitAnyway(err({ kind: 'stolen', userId: row.user_id as AuthUserId, reused: previous }));
  }

  async remembered(cookie: string): Promise<boolean> {
    const parts = parseCookie(cookie);
    if (!parts) return false;
    const row = await this.#db()
      .selectFrom(SIGN_INS_TABLE)
      .select('id')
      .where(selectorIs(parts.selector))
      .where(sql<boolean>`${sql.ref('remember_validator_hash')} is not null`)
      .executeTakeFirst();
    return row !== undefined;
  }

  async forgetToken(cookie: string): Promise<void> {
    const parts = parseCookie(cookie);
    if (parts) await this.#db().deleteFrom(SIGN_INS_TABLE).where(selectorIs(parts.selector)).execute();
  }

  async rebind(userId: AuthUserId, cookie: string, fingerprint: string): Promise<Result<void, RememberTokenError>> {
    const parts = parseCookie(cookie);
    if (!parts) return err({ kind: 'invalid' });
    const db = this.#db();
    // Scoped to the user: a cookie of another account's device is never re-stamped for this one.
    const row = await db
      .selectFrom(SIGN_INS_TABLE)
      .select((eb) => ['id', 'user_id', secret(eb, 'remember_validator_hash'), secret(eb, 'remember_previous_validator_hash'), 'remember_rotated_at', 'remember_until'])
      .where(selectorIs(parts.selector))
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row || row.remember_validator_hash === null || !(new Date(row.remember_until ?? 0).getTime() > this.#clock.now())) return err({ kind: 'invalid' });
    const presented = sha256(parts.validator);
    const rotatedAt = row.remember_rotated_at === null ? 0 : new Date(row.remember_rotated_at).getTime();
    const current = equal(presented, row.remember_validator_hash);
    const previous = row.remember_previous_validator_hash !== null && equal(presented, row.remember_previous_validator_hash);
    if (current || (previous && this.#clock.now() - rotatedAt < GRACE_MS)) {
      // Only the row whose validator is still the one that was checked: a rotation in between leaves it unstamped (refused later).
      const result = await db
        .updateTable(SIGN_INS_TABLE)
        .set({ remember_fingerprint: fingerprint, updated_at: this.#now() })
        .where('id', '=', row.id)
        .where('user_id', '=', userId)
        .where(sql<boolean>`${sql.ref('remember_validator_hash')} = ${row.remember_validator_hash}`)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n ? ok() : err({ kind: 'invalid' });
    }
    // A validator that is neither current nor just rotated: someone else holds a newer cookie of this token — the copy `consume()` reports.
    // Every sign-in of the account goes in one statement, and only the request that removed this row reports it.
    const removed = await db.deleteFrom(SIGN_INS_TABLE).where('user_id', '=', row.user_id).returning('id').execute();
    if (!removed.some((signIn) => signIn.id === row.id)) return commitAnyway(err({ kind: 'invalid' }));
    return commitAnyway(err({ kind: 'stolen', userId: row.user_id as AuthUserId, reused: previous }));
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  #db() {
    return this.#connections.get<{ [SIGN_INS_TABLE]: SignInsTable }>();
  }
}

// A row lives while its remember-me cookie does, or while it is within the idle limit (plus the write granularity) and the absolute one.
const lastSeenLimit = (now: number, window: SignInWindow) => new Date(now - (window.idleSeconds + SEEN_GRANULARITY_SECONDS) * 1000);
const signedInLimit = (now: number, window: SignInWindow) => new Date(now - window.maxSeconds * 1000);

/** The row whose remember-me selector this is. The column is a secret, so it is named in raw SQL like the other secrets. */
const selectorIs = (selector: string) => sql<boolean>`${sql.ref('remember_selector')} = ${selector}`;

function parseCookie(cookie: string): { selector: string; validator: string } | undefined {
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

/** Cleaned and cut to 255 characters; nothing left → `null`. */
function cleanUserAgent(userAgent: string | undefined): string | null {
  // Control and format characters (bidi overrides included) out; a cut must not leave half of a surrogate pair.
  const clean = (userAgent ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, USER_AGENT_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
  return clean === '' ? null : clean;
}
