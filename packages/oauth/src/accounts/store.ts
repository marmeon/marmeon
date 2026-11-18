import { Clock, err, ok, type Result } from '@marmeon/core';
import { Connections, Repository, secret, type Generated, type RowOf, type Secret } from '@marmeon/database';
import { DecryptError, Encrypter } from '@marmeon/encryption';
import type { AuthUserId } from '@marmeon/auth';
import type { OAuthTokens, SocialUser } from '../definition.ts';
import { SocialAccountsConfig } from './config.ts';

/** The table the app's migration creates — see {@link SocialAccountTable}. */
export const SOCIAL_ACCOUNTS_TABLE = 'social_accounts';

/**
 * The columns {@link SocialAccountStore} needs on `social_accounts`. The tokens are secret columns that hold ciphertext, and only
 * when `OAUTH_STORE_TOKENS` is on. See docs/oauth.md#storing-tokens.
 */
export interface SocialAccountTable {
  id: Generated<number>;
  user_id: number | string;
  provider: string;
  provider_id: string;
  email: string | null;
  nickname: string | null;
  access_token: Secret<string | null>;
  refresh_token: Secret<string | null>;
  token_expires_at: string | Date | null;
  scopes: string | null;
  last_used_at: string | Date | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** The columns readiness waits for on `social_accounts`. */
export const SOCIAL_ACCOUNT_COLUMNS = ['id', 'user_id', 'provider', 'provider_id', 'email', 'nickname', 'access_token', 'refresh_token', 'token_expires_at', 'scopes', 'last_used_at', 'created_at', 'updated_at'] as const satisfies readonly (keyof SocialAccountTable)[];

/** The longest `provider_id` the table holds: the limit of an OpenID Connect `sub`. A longer one is refused, never cut. */
const PROVIDER_ID_MAX = 255;

type Tables = { [SOCIAL_ACCOUNTS_TABLE]: SocialAccountTable };

/** A linked account. The tokens are not part of it: {@link SocialAccountStore.tokens} reads them. */
export interface SocialAccountRecord {
  readonly id: number;
  readonly userId: AuthUserId;
  readonly provider: string;
  /** The provider's identifier of the account, never the e-mail address. */
  readonly providerId: string;
  /** The address the provider reported at the last sign-in; it identifies nobody. */
  readonly email: string | null;
  readonly nickname: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

class SocialAccountRows extends Repository<typeof SOCIAL_ACCOUNTS_TABLE, Tables> {
  static readonly table = SOCIAL_ACCOUNTS_TABLE;
}

function recordOf(row: RowOf<SocialAccountTable>): SocialAccountRecord {
  return {
    id: Number(row.id),
    userId: row.user_id as AuthUserId,
    provider: row.provider,
    providerId: row.provider_id,
    email: row.email,
    nickname: row.nickname,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
  };
}

/** A provider account is named by a provider and an id: both non-empty strings, the id of at most 255 characters. Anything else is a bug of the caller. */
function checkName(provider: unknown, providerId: unknown): void {
  if (typeof provider !== 'string' || provider === '') throw new TypeError('A social account needs a provider name: a non-empty string.');
  if (typeof providerId !== 'string' || providerId === '') throw new TypeError('A social account needs the provider\'s id of it: a non-empty string.');
  if (providerId.length > PROVIDER_ID_MAX) throw new TypeError(`The provider's id of a social account is at most ${PROVIDER_ID_MAX} characters; this one has ${providerId.length}.`);
}

/**
 * Binds a token to its row: a ciphertext copied into another account's row does not decrypt there. `kind` keeps the access token
 * from standing in for the refresh token.
 */
const contextOf = (provider: string, providerId: string, kind: 'access_token' | 'refresh_token') => `social_accounts:${provider}:${providerId}:${kind}`;

/**
 * The accounts people link and sign in with, on the app's `social_accounts` table. A provider account belongs to one user and is never
 * moved to another: nothing here updates `user_id`. See docs/oauth.md#storing-tokens.
 */
export class SocialAccountStore {
  readonly #connections: Connections;
  readonly #clock: Clock;
  readonly #encrypter: Encrypter;
  readonly #config: SocialAccountsConfig;

  /** @internal Built by the container. */
  constructor(connections: Connections, clock: Clock, encrypter: Encrypter, config: SocialAccountsConfig) {
    this.#connections = connections;
    this.#clock = clock;
    this.#encrypter = encrypter;
    this.#config = config;
  }

  /** The account of this provider with this provider id, of any user, or `undefined`. Throws a `TypeError` when the provider or the id is empty, or the id is longer than 255 characters. */
  async find(provider: string, providerId: string): Promise<SocialAccountRecord | undefined> {
    checkName(provider, providerId);
    const row = await this.#db().selectFrom(SOCIAL_ACCOUNTS_TABLE).selectAll().where('provider', '=', provider).where('provider_id', '=', providerId).executeTakeFirst();
    return row === undefined ? undefined : recordOf(row);
  }

  /** The user's accounts, oldest first. */
  async forUser(userId: AuthUserId): Promise<readonly SocialAccountRecord[]> {
    const rows = await this.#db().selectFrom(SOCIAL_ACCOUNTS_TABLE).selectAll().where('user_id', '=', userId).orderBy('id', 'asc').execute();
    return rows.map(recordOf);
  }

  /**
   * Links the provider account of `user` to `userId`. `taken` when the provider account already belongs to a user (this one or another:
   * it is never moved), `provider-linked` when this user already has an account at the provider. Throws a `TypeError` when the provider or
   * the provider's id of `user` is empty, or the id is longer than 255 characters.
   */
  async create(userId: AuthUserId, user: SocialUser): Promise<Result<SocialAccountRecord, { kind: 'taken' } | { kind: 'provider-linked' }>> {
    checkName(user.provider, user.id);
    const now = this.#now();
    const result = await new SocialAccountRows(this.#connections).tryInsert({
      user_id: userId,
      provider: user.provider,
      provider_id: user.id,
      email: user.email,
      nickname: user.nickname,
      ...(await this.#tokenColumns(user)),
      refresh_token: await this.#refreshToken(user),
      last_used_at: now,
      created_at: now,
      updated_at: now,
    });
    if (result.ok) return ok(recordOf(result.value));
    // `provider_id` among the columns of the index that held means the provider account is taken. Any other answer is read back: a row
    // that breaks both indexes (the user links the same account twice) is reported on either, and the account being held decides.
    const taken = result.error.columns.includes('provider_id') || (await this.find(user.provider, user.id)) !== undefined;
    return err({ kind: taken ? ('taken' as const) : ('provider-linked' as const) });
  }

  /**
   * Notes a sign-in at account `id`: the address and nickname as the provider reports them now, the time, and the tokens when they are
   * stored — and cleared when `OAUTH_STORE_TOKENS` is off, so turning it off does not leave old tokens behind. A provider that sends no
   * refresh token on a later sign-in keeps the one stored, sealed again with the current key (so a key that left `APP_PREVIOUS_KEYS`
   * does not strand it). One that no key decrypts stays as it is until the provider sends a new one or the key is listed again, and
   * `touch` does not throw for it. The stored token is read and written in one transaction, so a parallel sign-in that brings a new
   * refresh token is not overwritten. Resolves with `false` and writes nothing when no row `id` belongs to the provider account of
   * `user` (the account was unlinked, or `user` is another one). Throws a `TypeError` like {@link create}.
   */
  async touch(id: number, user: SocialUser): Promise<boolean> {
    checkName(user.provider, user.id);
    const now = this.#now();
    const keeping = this.#config.storeTokens && user.tokens.refreshToken === undefined;
    const tokenColumns = await this.#tokenColumns(user);
    const write = async (refresh: { refresh_token: string | null } | Record<string, never>) => {
      const result = await this.#db()
        .updateTable(SOCIAL_ACCOUNTS_TABLE)
        .set({ email: user.email, nickname: user.nickname, ...tokenColumns, ...refresh, last_used_at: now, updated_at: now })
        .where('id', '=', id)
        .where('provider', '=', user.provider)
        .where('provider_id', '=', user.id)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    };
    if (!keeping) return write({ refresh_token: await this.#refreshToken(user) });
    return this.#connections.transaction(async () => write(await this.#resealedRefreshToken(id, user)));
  }

  /**
   * Unlinks the user's account at `provider`: `not-found` when there is none, `last-method` when `otherMethod` says the user could not
   * sign in without it. `otherMethod` is always asked, inside the transaction after the account is deleted, with the user's remaining
   * accounts (none when it was the last one), so the caller decides what counts as a way in: a password, a passkey, an account at a
   * provider that is still active. `false` rolls the delete back; so does an `otherMethod` that throws.
   *
   * The user's rows are locked first, so two removals at once cannot both see another account still there. `otherMethod` reads a password
   * or a passkey outside that lock: removing a passkey at the same moment is a limit, and the password reset remains the way back in.
   */
  async remove(userId: AuthUserId, provider: string, otherMethod: (remaining: readonly SocialAccountRecord[]) => Promise<boolean>): Promise<Result<SocialAccountRecord, { kind: 'not-found' } | { kind: 'last-method' }>> {
    return this.#connections.transaction(async () => {
      const db = this.#db();
      const locked = await db.selectFrom(SOCIAL_ACCOUNTS_TABLE).selectAll().where('user_id', '=', userId).orderBy('id', 'asc').forUpdate().execute();
      const row = locked.find((candidate) => candidate.provider === provider);
      if (row === undefined) return err({ kind: 'not-found' as const });
      await db.deleteFrom(SOCIAL_ACCOUNTS_TABLE).where('id', '=', row.id).where('user_id', '=', userId).execute();
      const remaining = locked.filter((candidate) => candidate !== row).map(recordOf);
      if (!(await otherMethod(remaining))) return err({ kind: 'last-method' as const }); // an err rolls the delete back
      return ok(recordOf(row));
    });
  }

  /**
   * Deletes every account of the user, whatever it is worth as a way in. It joins the transaction it is called in: the password reset of
   * an account with an unconfirmed address calls it in its own. Resolves with how many rows went.
   */
  async removeAll(userId: AuthUserId): Promise<number> {
    const result = await this.#db().deleteFrom(SOCIAL_ACCOUNTS_TABLE).where('user_id', '=', userId).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * The stored tokens of the user's account at `provider`, decrypted; `undefined` when there are none: `OAUTH_STORE_TOKENS` is off (nothing
   * is read then), or the account has no tokens. Throws `DecryptError` when a token does not decrypt: it was moved to another row, or
   * its key is no longer in `APP_PREVIOUS_KEYS`. See docs/oauth.md#storing-tokens.
   */
  async tokens(userId: AuthUserId, provider: string): Promise<OAuthTokens | undefined> {
    if (!this.#config.storeTokens) return undefined;
    const row = await this.#db()
      .selectFrom(SOCIAL_ACCOUNTS_TABLE)
      .select((eb) => ['provider', 'provider_id', secret(eb, 'access_token'), secret(eb, 'refresh_token'), 'token_expires_at', 'scopes'])
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    if (row === undefined || row.access_token === null) return undefined;
    const refreshToken = row.refresh_token === null ? undefined : await this.#encrypter.decrypt(row.refresh_token, contextOf(row.provider, row.provider_id, 'refresh_token'));
    return {
      accessToken: await this.#encrypter.decrypt(row.access_token, contextOf(row.provider, row.provider_id, 'access_token')),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(row.token_expires_at === null ? {} : { expiresAt: new Date(row.token_expires_at).getTime() }),
      scopes: row.scopes === null || row.scopes === '' ? [] : row.scopes.split(' '),
    };
  }

  /** The token columns to write besides the refresh token: encrypted and bound to the row with `OAUTH_STORE_TOKENS`, `NULL` without it. */
  async #tokenColumns(user: SocialUser) {
    if (!this.#config.storeTokens) return { access_token: null, token_expires_at: null, scopes: null };
    const { tokens } = user;
    return {
      access_token: await this.#encrypter.encrypt(tokens.accessToken, contextOf(user.provider, user.id, 'access_token')),
      token_expires_at: tokens.expiresAt === undefined ? null : new Date(tokens.expiresAt),
      scopes: tokens.scopes.join(' '),
    };
  }

  /**
   * The column to write for the stored refresh token of row `id` (locked until the transaction ends): it decrypted and sealed again with
   * the current key under the same context, `NULL` when there is none, nothing at all when it does not decrypt, so the column stays as it
   * is and an operator can list the key again.
   */
  async #resealedRefreshToken(id: number, user: SocialUser): Promise<{ refresh_token: string | null } | Record<string, never>> {
    const row = await this.#db()
      .selectFrom(SOCIAL_ACCOUNTS_TABLE)
      .select((eb) => [secret(eb, 'refresh_token')])
      .where('id', '=', id)
      .where('provider', '=', user.provider)
      .where('provider_id', '=', user.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined || row.refresh_token === null) return { refresh_token: null };
    const context = contextOf(user.provider, user.id, 'refresh_token');
    try {
      return { refresh_token: await this.#encrypter.encrypt(await this.#encrypter.decrypt(row.refresh_token, context), context) };
    } catch (error) {
      if (error instanceof DecryptError) return {};
      throw error;
    }
  }

  /** The encrypted refresh token to write, `NULL` without one or without `OAUTH_STORE_TOKENS`. */
  async #refreshToken(user: SocialUser): Promise<string | null> {
    const token = user.tokens.refreshToken;
    return !this.#config.storeTokens || token === undefined ? null : this.#encrypter.encrypt(token, contextOf(user.provider, user.id, 'refresh_token'));
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  #db() {
    return this.#connections.get<Tables>();
  }
}
