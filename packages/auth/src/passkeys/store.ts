import { randomBytes } from 'node:crypto';
import { Clock, ok, type Result } from '@marmeon/core';
import { Connections, Repository, type Generated, type Selectable } from '@marmeon/database';
import type { SecondFactor, TwoFactorState } from '../two-factor/state.ts';
import { RECOVERY_CODES_TABLE, TWO_FACTOR_TABLE } from '../two-factor/store.ts';

/** The table the app's migration creates (`make:auth` writes it) — see {@link PasskeyTable}. */
export const PASSKEYS_TABLE = 'passkeys';

/**
 * The columns {@link PasskeyStore} needs on `passkeys`. The public key is public: stored as it is, not `.secret()`.
 * `user_handle` is the account's random handle, the same in every row of the account.
 */
export interface PasskeyTable {
  id: Generated<number>;
  user_id: number | string;
  user_handle: string;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number | string;
  transports: unknown;
  aaguid: string;
  backup_eligible: boolean | number;
  backed_up: boolean | number;
  name: string;
  last_used_at: string | Date | null;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

type Tables = { [PASSKEYS_TABLE]: PasskeyTable; [RECOVERY_CODES_TABLE]: { user_id: number | string }; [TWO_FACTOR_TABLE]: { id: number; user_id: number | string; confirmed_at: string | Date | null } };

/** A stored passkey. */
export interface PasskeyRecord {
  readonly id: number;
  readonly userId: number | string;
  /** The account's user handle, base64url. */
  readonly userHandle: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly name: string;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

/** What {@link PasskeyStore.create} takes: a verified registration plus the account and a name. */
export interface NewPasskey {
  readonly userId: number | string;
  readonly userHandle: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly name: string;
}

class PasskeyRows extends Repository<typeof PASSKEYS_TABLE, Tables> {
  static readonly table = PASSKEYS_TABLE;
}

const flag = (value: unknown) => value === true || value === 1 || value === '1' || value === 't';

function recordOf(row: Selectable<PasskeyTable>): PasskeyRecord {
  const transports = typeof row.transports === 'string' ? (JSON.parse(row.transports) as unknown) : row.transports;
  return {
    id: Number(row.id),
    userId: row.user_id,
    userHandle: row.user_handle,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    algorithm: Number(row.algorithm),
    signCount: Number(row.sign_count),
    transports: Array.isArray(transports) ? transports.filter((item): item is string => typeof item === 'string') : [],
    aaguid: row.aaguid,
    backupEligible: flag(row.backup_eligible),
    backedUp: flag(row.backed_up),
    name: row.name,
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
    createdAt: new Date(row.created_at),
  };
}

/**
 * The passkeys of the accounts, on the app's `passkeys` table. Binding it (next to the TOTP store, through `combineFactors`)
 * as the {@link TwoFactorState} makes a registered passkey a second factor of its account.
 *
 * The sign count is written by a single conditional `UPDATE`: of parallel sign-ins with one counter exactly one wins.
 */
export class PasskeyStore implements TwoFactorState {
  readonly #connections: Connections;
  readonly #clock: Clock;

  constructor(connections: Connections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  /** `['passkey']` when the account has at least one passkey. */
  async factors(userId: number | string): Promise<readonly SecondFactor[]> {
    const row = await this.#db().selectFrom(PASSKEYS_TABLE).select('id').where('user_id', '=', userId).executeTakeFirst();
    return row === undefined ? [] : ['passkey'];
  }

  /** The registration of the account's oldest passkey. */
  async enabledSince(userId: number | string): Promise<Date | undefined> {
    const row = await this.#db().selectFrom(PASSKEYS_TABLE).select('created_at').where('user_id', '=', userId).orderBy('created_at', 'asc').executeTakeFirst();
    return row === undefined ? undefined : new Date(row.created_at);
  }

  /**
   * The account's user handle, base64url: the one its passkeys already carry, else a fresh one of 32 random bytes (never the id or
   * the address). The caller puts the handle into the registration options and keeps it with the open challenge, then hands that
   * same value to {@link create} — it never asks again: the authenticator holds the handle from the options, and a passkey stored
   * with another one could not sign in. An account may therefore end up with two handles after a race; that is harmless.
   */
  async userHandle(userId: number | string): Promise<string> {
    const row = await this.#db().selectFrom(PASSKEYS_TABLE).select('user_handle').where('user_id', '=', userId).executeTakeFirst();
    return row?.user_handle ?? randomBytes(32).toString('base64url');
  }

  /** Stores a passkey; `duplicate` when the credential id is already registered (to any account). */
  async create(passkey: NewPasskey): Promise<Result<PasskeyRecord, { kind: 'duplicate' }>> {
    const now = this.#now();
    // Stored exactly as given: it is the handle the authenticator got in the options (see `userHandle()`).
    const result = await new PasskeyRows(this.#connections).tryInsert({
      user_id: passkey.userId,
      user_handle: passkey.userHandle,
      credential_id: passkey.credentialId,
      public_key: passkey.publicKey,
      algorithm: passkey.algorithm,
      sign_count: passkey.signCount,
      transports: JSON.stringify(passkey.transports),
      aaguid: passkey.aaguid,
      backup_eligible: passkey.backupEligible,
      backed_up: passkey.backedUp,
      name: passkey.name,
      last_used_at: null,
      created_at: now,
      updated_at: now,
    });
    return result.ok ? ok(recordOf(result.value)) : result;
  }

  /** @internal The passkey with this credential id, of any account — the caller checks that it belongs to the one expected. */
  async findByCredentialId(credentialId: string): Promise<PasskeyRecord | undefined> {
    const row = await this.#db().selectFrom(PASSKEYS_TABLE).selectAll().where('credential_id', '=', credentialId).executeTakeFirst();
    return row === undefined ? undefined : recordOf(row);
  }

  /** The account's passkeys, oldest first. */
  async forUser(userId: number | string): Promise<readonly PasskeyRecord[]> {
    const rows = await this.#db().selectFrom(PASSKEYS_TABLE).selectAll().where('user_id', '=', userId).orderBy('id', 'asc').execute();
    return rows.map(recordOf);
  }

  /**
   * Moves the sign count of passkey `id` from `previous` to `next` and notes the use — only when the stored count is still
   * `previous`. `false` when it is not: another sign-in got there first, and this one must be refused.
   */
  async updateCounter(id: number, previous: number, next: number, backedUp: boolean): Promise<boolean> {
    const now = this.#now();
    const result = await this.#db()
      .updateTable(PASSKEYS_TABLE)
      .set({ sign_count: next, backed_up: backedUp, last_used_at: now, updated_at: now })
      .where('id', '=', id)
      .where('sign_count', '=', previous)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Renames the account's passkey; `false` when it has none with this id. */
  async rename(userId: number | string, id: number, name: string): Promise<boolean> {
    const result = await this.#db().updateTable(PASSKEYS_TABLE).set({ name, updated_at: this.#now() }).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Removes the account's passkey. `removed: false` when it has none with this id. `lastFactor` says that no factor is left —
   * no other passkey and no confirmed authenticator — and then the recovery codes went in the same transaction (they belong to
   * the account's factors, not to this one). The account's passkey rows are locked first (Postgres), so two removals at once
   * cannot both see the other passkey still there and leave codes behind with no factor.
   */
  async remove(userId: number | string, id: number): Promise<{ removed: boolean; lastFactor: boolean }> {
    return this.#connections.transaction(async () => {
      const db = this.#db();
      if (this.#connections.options().driver === 'pgsql') await db.selectFrom(PASSKEYS_TABLE).select('id').where('user_id', '=', userId).forUpdate().execute();
      const result = await db.deleteFrom(PASSKEYS_TABLE).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
      if (result.numDeletedRows === 0n) return { removed: false, lastFactor: false };
      const otherPasskey = await db.selectFrom(PASSKEYS_TABLE).select('id').where('user_id', '=', userId).executeTakeFirst();
      const totp = await db.selectFrom(TWO_FACTOR_TABLE).select('id').where('user_id', '=', userId).where('confirmed_at', 'is not', null).executeTakeFirst();
      const lastFactor = otherPasskey === undefined && totp === undefined;
      if (lastFactor) await db.deleteFrom(RECOVERY_CODES_TABLE).where('user_id', '=', userId).execute();
      return { removed: true, lastFactor };
    });
  }

  /** Removes every passkey of the account (the operator's reset); the recovery codes are the caller's. */
  async removeAll(userId: number | string): Promise<void> {
    await this.#db().deleteFrom(PASSKEYS_TABLE).where('user_id', '=', userId).execute();
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  #db() {
    return this.#connections.get<Tables>();
  }
}
