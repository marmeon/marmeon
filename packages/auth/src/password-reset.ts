import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventDispatcher, token } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import { AuthConfig } from './config.ts';
import { PasswordReset } from './events.ts';
import { Hasher } from './hashing.ts';
import { RememberTokenStore } from './remember.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/** The table the app's migration creates (`make:auth` writes it) — see {@link PasswordResetTokenTable}. */
export const PASSWORD_RESET_TABLE = 'password_reset_tokens';

/**
 * The columns {@link DatabasePasswordResetTokens} needs:
 *
 * ```ts
 * schema.create('password_reset_tokens', (table) => {
 *   table.string('email').primary();
 *   table.string('token_hash', 64).secret();
 *   table.timestamp('created_at');
 * });
 * ```
 */
export interface PasswordResetTokenTable {
  email: string;
  token_hash: string;
  created_at: string | Date;
}

/**
 * Reset tokens: one per e-mail, stored only as SHA-256 (E27 — 256 random bits need no slow hash),
 * used once, valid for a while.
 */
export interface PasswordResetTokenStore {
  /** A new token for `email`, replacing an older one — `undefined` while the last one is younger than `throttleSeconds`. */
  create(email: string, throttleSeconds: number): Promise<string | undefined>;
  /** Whether `token` is the current token of `email` and younger than `maxAgeSeconds` — and if so, it is used up. */
  consume(email: string, token: string, maxAgeSeconds: number): Promise<boolean>;
  forget(email: string): Promise<void>;
}
export const PasswordResetTokenStore = token<PasswordResetTokenStore>('PasswordResetTokenStore');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The default {@link PasswordResetTokenStore}, on the app's `password_reset_tokens` table. */
export class DatabasePasswordResetTokens implements PasswordResetTokenStore {
  readonly #connections: Connections;

  constructor(connections: Connections) {
    this.#connections = connections;
  }

  async create(email: string, throttleSeconds: number): Promise<string | undefined> {
    const db = this.#db();
    const existing = await db.selectFrom(PASSWORD_RESET_TABLE).select('created_at').where('email', '=', email).executeTakeFirst();
    if (existing && Date.now() - new Date(existing.created_at).getTime() < throttleSeconds * 1000) return undefined;
    const value = randomBytes(32).toString('base64url');
    // The ambient transaction (E107): `db` joins it — and inside a caller's transaction this becomes a savepoint.
    await this.#connections.transaction(async () => {
      await db.deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).execute();
      await db.insertInto(PASSWORD_RESET_TABLE).values({ email, token_hash: sha256(value), created_at: new Date() }).execute();
    });
    return value;
  }

  async consume(email: string, value: string, maxAgeSeconds: number): Promise<boolean> {
    if (!TOKEN.test(value)) return false; // malformed: no query
    const db = this.#db();
    const row = await db.selectFrom(PASSWORD_RESET_TABLE).select(['token_hash', 'created_at']).where('email', '=', email).executeTakeFirst();
    if (!row) return false;
    if (Date.now() - new Date(row.created_at).getTime() >= maxAgeSeconds * 1000) {
      await this.forget(email);
      return false;
    }
    if (!equal(sha256(value), row.token_hash)) return false;
    // Used up — conditionally, so two requests with the same token cannot both succeed.
    const deleted = await db.deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).where('token_hash', '=', row.token_hash).executeTakeFirst();
    return deleted.numDeletedRows > 0n;
  }

  async forget(email: string): Promise<void> {
    await this.#db().deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).execute();
  }

  #db() {
    return this.#connections.get<{ [PASSWORD_RESET_TABLE]: PasswordResetTokenTable }>();
  }
}

/**
 * "Forgot password" (Laravel's password broker): a token for a known e-mail — sent by mail, never shown —
 * and the reset with it. After a reset every remember-me token of the user is gone and every
 * session ends (the password fingerprint changed).
 *
 * ```ts
 * this.#afterResponse.defer(async () => {   // same answer, same time, whether the e-mail exists or not
 *   const reset = await this.#broker.createToken(email);
 *   if (reset) await this.#mailer.send(new ResetPasswordMail(reset.user, urlWith(reset.token)));
 * });
 * ```
 */
export class PasswordBroker {
  readonly #users: UserProvider;
  readonly #tokens: PasswordResetTokenStore;
  readonly #hasher: Hasher;
  readonly #remember: RememberTokenStore;
  readonly #events: EventDispatcher;
  readonly #config: AuthConfig;

  constructor(users: UserProvider, tokens: PasswordResetTokenStore, hasher: Hasher, remember: RememberTokenStore, events: EventDispatcher, config: AuthConfig) {
    this.#users = users;
    this.#tokens = tokens;
    this.#hasher = hasher;
    this.#remember = remember;
    this.#events = events;
    this.#config = config;
  }

  /** A token for `email` (normalized like the login) — `undefined` for an unknown e-mail, and within `AUTH_RESET_THROTTLE` of the last one. */
  async createToken(email: string): Promise<{ user: AuthUser; token: string } | undefined> {
    const found = await this.#users.findForLogin(email);
    if (!found) return undefined;
    const value = await this.#tokens.create(email, this.#config.resetThrottle);
    return value === undefined ? undefined : { user: found.user, token: value };
  }

  /**
   * Sets `password` if `token` belongs to `email` and is unused and fresh. One answer — `undefined` — for
   * an unknown e-mail and a wrong, used or expired token.
   */
  async reset(email: string, value: string, password: string): Promise<AuthUser | undefined> {
    if (!(await this.#tokens.consume(email, value, this.#config.resetExpire * 60))) return undefined;
    const found = await this.#users.findForLogin(email);
    if (!found) return undefined;
    await this.#users.updatePasswordHash(idOf(found.user) as never, await this.#hasher.make(password));
    await this.#remember.forgetUser(idOf(found.user));
    await this.#events.dispatch(new PasswordReset(found.user));
    return found.user;
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
