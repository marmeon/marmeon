import { ConsoleLogger, ok, type Logger } from '@marmeon/core';
import { Connections, sql } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshPgsqlDatabase, PGSQL_URL } from './__fixtures__/databases.ts';
import { rotateSessionKey } from './account-sessions.ts';
import type { AuthUser, Credentials, UserProvider } from './index.ts';

interface AccountsTable {
  accounts: { id: number; session_key: string | null };
}

const silent: Logger = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });
const user: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

/** Accounts in a `session_key` column, written by compare-and-set in one statement — as an app's repository does it. */
class Accounts implements UserProvider {
  readonly #connections: Connections;
  constructor(connections: Connections) {
    this.#connections = connections;
  }
  #db() {
    return this.#connections.get<AccountsTable>();
  }
  async findById(id: number): Promise<Credentials | undefined> {
    const row = await this.#db().selectFrom('accounts').select('session_key').where('id', '=', Number(id)).executeTakeFirst();
    return row && { user, passwordHash: null, sessionKey: row.session_key };
  }
  async findForLogin(): Promise<Credentials | undefined> {
    return undefined;
  }
  async updatePasswordHash(): Promise<boolean> {
    return false;
  }
  async updateEverySessionKey(): Promise<{ accounts: number; sampleId: undefined }> {
    return { accounts: 0, sampleId: undefined };
  }
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    let update = this.#db().updateTable('accounts').set({ session_key: key }).where('id', '=', Number(id));
    if (expected !== undefined) update = expected === null ? update.where('session_key', 'is', null) : update.where('session_key', '=', expected);
    return (await update.executeTakeFirst()).numUpdatedRows > 0n;
  }
}

// Postgres only (`pnpm test:pgsql`): the row lock is what makes `Auth[CLAIM_ACCOUNT]` hold an ending back until the factor is stored.
describe.skipIf(!PGSQL_URL)('the account row while a factor is stored (pgsql)', () => {
  let connections: Connections;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const fresh = await freshPgsqlDatabase();
    drop = fresh.drop;
    connections = new Connections({ connections: { default: { driver: 'pgsql', url: fresh.url, poolMax: 3, managed: false } }, root: '/', logger: silent });
    await sql`create table accounts (id integer primary key, session_key text)`.execute(connections.get());
    await sql`insert into accounts (id, session_key) values (1, 'first-key')`.execute(connections.get());
  });

  afterAll(async () => {
    await connections.destroy();
    await drop();
  });

  it('holds AccountSessions.end() back until the transaction that stores the factor has committed', async () => {
    const users = new Accounts(connections);
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const storing = connections.transaction(async () => {
      expect(await users.updateSessionKey(1, 'first-key', 'first-key')).toBe(true); // the claim: same key, row locked until the commit
      locked();
      await released;
      return ok(undefined);
    });
    await holding;

    let ended = false;
    const ending = rotateSessionKey(users, 1, undefined, 'AccountSessions.end()').then((result) => {
      ended = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ended, 'the ending waits for the row').toBe(false);

    release();
    await storing;
    expect((await ending).kind).toBe('rotated');
    expect((await users.findById(1))?.sessionKey).not.toBe('first-key');
  });

  it('makes the claim fail when the ending came first', async () => {
    const users = new Accounts(connections);
    await rotateSessionKey(users, 1, undefined, 'AccountSessions.end()');
    const claimed = await connections.transaction(async () => users.updateSessionKey(1, 'first-key', 'first-key'));
    expect(claimed).toBe(false);
  });
});
