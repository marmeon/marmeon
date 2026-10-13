import { Clock } from '@marmeon/core';
import { Connections, secret, sql, type Generated, type Secret } from '@marmeon/database';
import type { SecondFactor, TwoFactorState } from './state.ts';

/** The tables the app's migration creates (`make:auth` writes them) — see {@link TwoFactorTable} and {@link RecoveryCodeTable}. */
export const TWO_FACTOR_TABLE = 'two_factor_authentications';
export const RECOVERY_CODES_TABLE = 'two_factor_recovery_codes';

/** The columns {@link TwoFactorStore} needs on `two_factor_authentications`: the secret is encrypted, `confirmed_at` is `null` while setup is unfinished. */
export interface TwoFactorTable {
  id: Generated<number>;
  user_id: number | string;
  secret: Secret<string>;
  confirmed_at: string | Date | null;
  last_used_step: number | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** The columns it needs on `two_factor_recovery_codes`: only the hash of a code is stored. */
export interface RecoveryCodeTable {
  id: Generated<number>;
  user_id: number | string;
  code_hash: Secret<string>;
  used_at: string | Date | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** What the store keeps for an account's authenticator: the secret still encrypted (the service decrypts it). */
export interface TotpRecord {
  readonly encryptedSecret: string;
  readonly confirmed: boolean;
  readonly lastUsedStep: number | null;
}

type Tables = { [TWO_FACTOR_TABLE]: TwoFactorTable; [RECOVERY_CODES_TABLE]: RecoveryCodeTable };

/**
 * The TOTP factor and the recovery codes of an account, on the app's `two_factor_authentications` and
 * `two_factor_recovery_codes` tables. Binding it as the {@link TwoFactorState} lets accounts set a factor up.
 *
 * Replay protection lives here, in single conditional `UPDATE`s: a TOTP step and a recovery code each count at most once,
 * however many requests race for them.
 */
export class TwoFactorStore implements TwoFactorState {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  /** `['totp']` once the authenticator is confirmed; a setup that was begun but not confirmed changes nothing about signing in. */
  async factors(userId: number | string): Promise<readonly SecondFactor[]> {
    const row = await this.#db().selectFrom(TWO_FACTOR_TABLE).select('id').where('user_id', '=', userId).where('confirmed_at', 'is not', null).executeTakeFirst();
    return row === undefined ? [] : ['totp'];
  }

  /** @internal The account's authenticator row, confirmed or not; the service decrypts the secret. */
  async find(userId: number | string): Promise<TotpRecord | undefined> {
    const row = await this.#db()
      .selectFrom(TWO_FACTOR_TABLE)
      .select((eb) => [secret(eb, 'secret'), 'confirmed_at', 'last_used_step'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return { encryptedSecret: row.secret, confirmed: row.confirmed_at !== null, lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step) };
  }

  /** Starts setting up an authenticator with this (encrypted) secret, replacing an unconfirmed attempt. Throws when one is already confirmed: disable it first. */
  async startSetup(userId: number | string, encryptedSecret: string): Promise<void> {
    const now = this.#now();
    // One statement decides, so parallel starts (a double click) never collide: the unique index on `user_id` turns the second into an
    // update of the unconfirmed row, and a confirmed row is never touched — then nothing changes and we refuse.
    const result = await this.#db()
      .insertInto(TWO_FACTOR_TABLE)
      .values({ user_id: userId, secret: encryptedSecret, confirmed_at: null, last_used_step: null, created_at: now, updated_at: now })
      .onConflict((conflict) =>
        conflict
          .column('user_id')
          .doUpdateSet({ secret: encryptedSecret, last_used_step: null, created_at: now, updated_at: now })
          .where(`${TWO_FACTOR_TABLE}.confirmed_at`, 'is', null),
      )
      .executeTakeFirst();
    if (result.numInsertedOrUpdatedRows === 0n) throw new Error('Two-factor authentication with an authenticator app is already on for this account: disable it first.');
  }

  /**
   * Confirms a started setup: the code's `step` counts as used, the secret is stored re-encrypted, and — when this is the
   * account's first factor — its recovery code hashes are stored, all in one transaction. `false` when there is nothing
   * to confirm (never started, or already confirmed); then nothing changed.
   */
  async confirm(userId: number | string, step: number, reencryptedSecret: string, codeHashes: readonly string[] | null): Promise<boolean> {
    return this.#connections.transaction(async () => {
      const now = this.#now();
      const result = await this.#db()
        .updateTable(TWO_FACTOR_TABLE)
        .set({ confirmed_at: now, last_used_step: step, secret: reencryptedSecret, updated_at: now })
        .where('user_id', '=', userId)
        .where('confirmed_at', 'is', null)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return false;
      if (codeHashes !== null) await this.#replaceCodes(userId, codeHashes);
      return true;
    });
  }

  /**
   * Accepts a TOTP `step` — and stores the secret re-encrypted with the current key — only when it is newer than every step
   * used before. One conditional `UPDATE` decides: a code works once, even for parallel requests, and no older code works after a newer one.
   */
  async useStep(userId: number | string, step: number, reencryptedSecret: string): Promise<boolean> {
    const result = await this.#db()
      .updateTable(TWO_FACTOR_TABLE)
      .set({ last_used_step: step, secret: reencryptedSecret, updated_at: this.#now() })
      .where('user_id', '=', userId)
      .where('confirmed_at', 'is not', null)
      .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', step)]))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Spends a recovery code by its hash: how many are left, or `undefined` when it is unknown or already spent. One conditional `UPDATE`: a code works once, even in parallel. */
  async consumeRecoveryCode(userId: number | string, codeHash: string): Promise<number | undefined> {
    const now = this.#now();
    const result = await this.#db()
      .updateTable(RECOVERY_CODES_TABLE)
      .set({ used_at: now, updated_at: now })
      .where('user_id', '=', userId)
      .where(sql<boolean>`${sql.ref('code_hash')} = ${codeHash}`)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return undefined;
    return this.remainingRecoveryCodes(userId);
  }

  /** Replaces every recovery code of the account (spent or not) with these hashes, in one transaction. */
  async replaceRecoveryCodes(userId: number | string, codeHashes: readonly string[]): Promise<void> {
    await this.#connections.transaction(() => this.#replaceCodes(userId, codeHashes));
  }

  async remainingRecoveryCodes(userId: number | string): Promise<number> {
    const row = await this.#db()
      .selectFrom(RECOVERY_CODES_TABLE)
      .select((eb) => eb.fn.countAll<number | string>().as('remaining'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.remaining);
  }

  /** Removes the authenticator; with `lastFactor` the recovery codes go in the same transaction (they belong to the account's factors, not to this one). */
  async removeTotp(userId: number | string, { lastFactor }: { lastFactor: boolean }): Promise<void> {
    await this.#connections.transaction(async () => {
      await this.#db().deleteFrom(TWO_FACTOR_TABLE).where('user_id', '=', userId).execute();
      if (lastFactor) await this.#db().deleteFrom(RECOVERY_CODES_TABLE).where('user_id', '=', userId).execute();
    });
  }

  /** Removes the authenticator and every recovery code (the operator's reset). */
  async removeAll(userId: number | string): Promise<void> {
    await this.removeTotp(userId, { lastFactor: true });
  }

  async #replaceCodes(userId: number | string, codeHashes: readonly string[]): Promise<void> {
    const db = this.#db();
    await db.deleteFrom(RECOVERY_CODES_TABLE).where('user_id', '=', userId).execute();
    if (codeHashes.length === 0) return;
    const now = this.#now();
    await db
      .insertInto(RECOVERY_CODES_TABLE)
      .values(codeHashes.map((hash) => ({ user_id: userId, code_hash: hash, used_at: null, created_at: now, updated_at: now })))
      .execute();
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  #db() {
    return this.#connections.get<Tables>();
  }
}
