import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Clock, commitAnyway, err, EventDispatcher, ok, token, type Result } from '@marmeon/core';
import { Connections, secret, sql, type Secret } from '@marmeon/database';
import { AuthConfig } from './config.ts';
import { PasswordReset } from './events.ts';
import { Hasher } from './hashing.ts';
import { NewPassword } from './new-password.ts';
import { RememberTokenStore } from './remember.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/** The table the app's migration creates (`make:auth` writes it) — see {@link PasswordResetTokenTable}. */
export const PASSWORD_RESET_TABLE = 'password_reset_tokens';

/**
 * The columns {@link DatabasePasswordResetTokens} needs — the `password_reset_tokens` migration `make:auth` writes into
 * `modules/auth/migrations/` creates them (the token only as its SHA-256, a `secret()` column).
 */
export interface PasswordResetTokenTable {
  email: string;
  token_hash: Secret<string>;
  created_at: string | Date;
}

/**
 * Reset tokens: one per e-mail, stored only as SHA-256 (256 random bits need no slow hash),
 * used once, valid for a while.
 */
export interface PasswordResetTokenStore {
  /** A new token for `email`, replacing an older one — an `err` of kind `throttled` while the last one is younger than `throttleSeconds`. */
  create(email: string, throttleSeconds: number): Promise<Result<string, { readonly kind: 'throttled' }>>;
  /**
   * Uses `token` up if it is the current token of `email` and younger than `maxAgeSeconds`; otherwise an `err` of kind `invalid-token`
   * — one kind for a malformed, unknown, wrong and expired token on purpose. The deletion of an expired token must commit even inside a
   * transaction that returns the err (`commitAnyway`).
   */
  consume(email: string, token: string, maxAgeSeconds: number): Promise<Result<void, { readonly kind: 'invalid-token' }>>;
  forget(email: string): Promise<void>;
  /** Deletes every token older than `maxAgeSeconds` — expired ones nobody used (`marmeon auth:prune-tokens`). How many. */
  prune(maxAgeSeconds: number): Promise<number>;
  /** Deletes every token, valid or not (`AccountSessions.endEveryone()`): a link that was mailed before a leak must not work after it. How many. */
  forgetEveryone?(): Promise<number>;
}
export const PasswordResetTokenStore = token<PasswordResetTokenStore>('PasswordResetTokenStore');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The default {@link PasswordResetTokenStore}, on the app's `password_reset_tokens` table. */
export class DatabasePasswordResetTokens implements PasswordResetTokenStore {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  async create(email: string, throttleSeconds: number): Promise<Result<string, { readonly kind: 'throttled' }>> {
    const db = this.#db();
    const existing = await db.selectFrom(PASSWORD_RESET_TABLE).select('created_at').where('email', '=', email).executeTakeFirst();
    if (existing && this.#clock.now() - new Date(existing.created_at).getTime() < throttleSeconds * 1000) return err({ kind: 'throttled' });
    const value = randomBytes(32).toString('base64url');
    // The ambient transaction: `db` joins it — and inside a caller's transaction this becomes a savepoint.
    await this.#connections.transaction(async () => {
      await db.deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).execute();
      await db.insertInto(PASSWORD_RESET_TABLE).values({ email, token_hash: sha256(value), created_at: new Date(this.#clock.now()) }).execute();
    });
    return ok(value);
  }

  async consume(email: string, value: string, maxAgeSeconds: number): Promise<Result<void, { readonly kind: 'invalid-token' }>> {
    if (!TOKEN.test(value)) return err({ kind: 'invalid-token' }); // malformed: no query
    const db = this.#db();
    const row = await db.selectFrom(PASSWORD_RESET_TABLE).select((eb) => [secret(eb, 'token_hash'), 'created_at']).where('email', '=', email).executeTakeFirst();
    if (!row) return err({ kind: 'invalid-token' });
    if (this.#clock.now() - new Date(row.created_at).getTime() >= maxAgeSeconds * 1000) {
      await this.forget(email);
      return commitAnyway(err({ kind: 'invalid-token' })); // the deletion stays when an ambient transaction would roll back an err
    }
    if (!equal(sha256(value), row.token_hash)) return err({ kind: 'invalid-token' });
    // Used up — conditionally, so two requests with the same token cannot both succeed.
    const deleted = await db.deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).where(sql<boolean>`${sql.ref('token_hash')} = ${row.token_hash}`).executeTakeFirst();
    return deleted.numDeletedRows > 0n ? ok() : err({ kind: 'invalid-token' });
  }

  async forget(email: string): Promise<void> {
    await this.#db().deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).execute();
  }

  async forgetEveryone(): Promise<number> {
    return Number((await this.#db().deleteFrom(PASSWORD_RESET_TABLE).executeTakeFirst()).numDeletedRows);
  }

  async prune(maxAgeSeconds: number): Promise<number> {
    const result = await this.#db()
      .deleteFrom(PASSWORD_RESET_TABLE)
      .where('created_at', '<=', new Date(this.#clock.now() - maxAgeSeconds * 1000))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #db() {
    return this.#connections.get<{ [PASSWORD_RESET_TABLE]: PasswordResetTokenTable }>();
  }
}

/**
 * "Forgot password": a token for a known e-mail — sent by mail, never shown — and the reset with it. After a reset every
 * remember-me token of the user is gone and every session ends; with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API
 * token too. Make the token in a job, so the request answers the same, in the same time, whether the e-mail has an account
 * or not. See `docs/passwords.md#asking-for-a-link`.
 */
export class PasswordBroker {
  readonly #users: UserProvider;
  readonly #tokens: PasswordResetTokenStore;
  readonly #hasher: Hasher;
  readonly #events: EventDispatcher;
  readonly #config: AuthConfig;
  readonly #remember: RememberTokenStore;
  readonly #newPassword: NewPassword;

  constructor(
    users: UserProvider,
    tokens: PasswordResetTokenStore,
    hasher: Hasher,
    remember: RememberTokenStore,
    events: EventDispatcher,
    config: AuthConfig,
    newPassword: NewPassword,
  ) {
    this.#users = users;
    this.#tokens = tokens;
    this.#hasher = hasher;
    this.#events = events;
    this.#config = config;
    this.#remember = remember;
    this.#newPassword = newPassword;
  }

  /**
   * A token for `email` (normalized like the login), or an `err` of kind `unavailable`. There is one kind for an unknown e-mail and for
   * one within `AUTH_RESET_THROTTLE` of the last token, so the answer never tells whether an account exists.
   */
  async createToken(email: string): Promise<Result<{ user: AuthUser; token: string }, { readonly kind: 'unavailable' }>> {
    const found = await this.#users.findForLogin(email);
    if (!found) return err({ kind: 'unavailable' });
    const created = await this.#tokens.create(email, this.#config.resetThrottle);
    return created.ok ? ok({ user: found.user, token: created.value }) : err({ kind: 'unavailable' });
  }

  /**
   * Sets `password` if `token` belongs to `email` and is unused and fresh: `ok` with the user. One answer — an `err` of
   * kind `invalid-token` — for an unknown e-mail and a wrong, used or expired token, so the answer never tells whether an account exists. With `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, every API token
   * of the user is revoked in the transaction of the new hash.
   */
  async reset(email: string, value: string, password: string): Promise<Result<AuthUser, { readonly kind: 'invalid-token' }>> {
    const consumed = await this.#tokens.consume(email, value, this.#config.resetExpire * 60);
    if (!consumed.ok) return consumed; // as the store made it: an expired token's deletion keeps its commitAnyway
    const found = await this.#users.findForLogin(email);
    if (!found) return commitAnyway(err({ kind: 'invalid-token' })); // the token is used up for good
    const revoked = await this.#newPassword.store(this.#users, this.#remember, idOf(found.user), await this.#hasher.make(password), 'reset', found.user);
    await this.#events.dispatch(new PasswordReset(found.user, revoked));
    return ok(found.user);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
