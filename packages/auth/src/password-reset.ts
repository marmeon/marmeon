import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Clock, EventDispatcher, token } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { AuthConfig } from './config.ts';
import { PasswordReset } from './events.ts';
import { Hasher } from './hashing.ts';
import { NewPassword } from './new-password.ts';
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
  /** Deletes every token older than `maxAgeSeconds` — expired ones nobody used (`marmeon auth:prune-tokens`). How many. */
  prune(maxAgeSeconds: number): Promise<number>;
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

  async create(email: string, throttleSeconds: number): Promise<string | undefined> {
    const db = this.#db();
    const existing = await db.selectFrom(PASSWORD_RESET_TABLE).select('created_at').where('email', '=', email).executeTakeFirst();
    if (existing && this.#clock.now() - new Date(existing.created_at).getTime() < throttleSeconds * 1000) return undefined;
    const value = randomBytes(32).toString('base64url');
    // The ambient transaction (E107): `db` joins it — and inside a caller's transaction this becomes a savepoint.
    await this.#connections.transaction(async () => {
      await db.deleteFrom(PASSWORD_RESET_TABLE).where('email', '=', email).execute();
      await db.insertInto(PASSWORD_RESET_TABLE).values({ email, token_hash: sha256(value), created_at: new Date(this.#clock.now()) }).execute();
    });
    return value;
  }

  async consume(email: string, value: string, maxAgeSeconds: number): Promise<boolean> {
    if (!TOKEN.test(value)) return false; // malformed: no query
    const db = this.#db();
    const row = await db.selectFrom(PASSWORD_RESET_TABLE).select(['token_hash', 'created_at']).where('email', '=', email).executeTakeFirst();
    if (!row) return false;
    if (this.#clock.now() - new Date(row.created_at).getTime() >= maxAgeSeconds * 1000) {
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
 * remember-me token of the user is gone and every session ends (the password fingerprint changed); with
 * `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token too. The request only queues a job — the same answer, in the same
 * time, whether the e-mail has an account or not — and the job makes the token and queues the mail:
 *
 * ```ts
 * async handle(payload: JobPayload<typeof SendPasswordResetLinkJob>): Promise<void> {
 *   const reset = await this.#broker.createToken(payload.email);
 *   if (!reset) return; // no account, or a link went out moments ago
 *   const url = new URL(this.#router.url('auth.password.reset', {}, { token: reset.token, email: payload.email }), this.#app.url);
 *   const t = this.#translators.for(reset.user.locale ?? payload.locale);
 *   await this.#mailer.queue(new ResetPasswordMail(reset.user, url.href, this.#auth.resetExpire, t), { queue: 'mail' });
 * }
 * ```
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

  /** A token for `email` (normalized like the login) — `undefined` for an unknown e-mail, and within `AUTH_RESET_THROTTLE` of the last one. */
  async createToken(email: string): Promise<{ user: AuthUser; token: string } | undefined> {
    const found = await this.#users.findForLogin(email);
    if (!found) return undefined;
    const value = await this.#tokens.create(email, this.#config.resetThrottle);
    return value === undefined ? undefined : { user: found.user, token: value };
  }

  /**
   * Sets `password` if `token` belongs to `email` and is unused and fresh. One answer — `undefined` — for
   * an unknown e-mail and a wrong, used or expired token. With `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, every API token
   * of the user is revoked in the transaction of the new hash.
   */
  async reset(email: string, value: string, password: string): Promise<AuthUser | undefined> {
    if (!(await this.#tokens.consume(email, value, this.#config.resetExpire * 60))) return undefined;
    const found = await this.#users.findForLogin(email);
    if (!found) return undefined;
    const revoked = await this.#newPassword.store(this.#users, this.#remember, idOf(found.user), await this.#hasher.make(password), 'reset');
    await this.#events.dispatch(new PasswordReset(found.user, revoked));
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
