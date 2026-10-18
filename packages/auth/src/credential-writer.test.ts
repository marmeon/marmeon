import { sql, type Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { credentialWriter } from './credential-writer.ts';
import type { PasswordHash } from './hashing.ts';

const OLD = 'old-hash' as PasswordHash;
const NEW = 'new-hash' as PasswordHash;
const KEY = 'k'.repeat(40);
const OTHER_KEY = 'o'.repeat(40);
const NEXT_KEY = 'n'.repeat(40);

describe.each(drivers)('credentialWriter on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const db = () => connections.get<any>();
  const row = async (id: number) => (await sql<{ password: string; session_key: string | null }>`select password, session_key from accounts where id = ${id}`.execute(db())).rows[0]!;
  const writer = () => credentialWriter(db(), { table: 'accounts' });

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    await sql`create table accounts (id integer primary key, password text not null, session_key text, updated_at text)`.execute(db());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await sql`delete from accounts`.execute(db());
    await sql`insert into accounts (id, password, session_key) values (1, ${OLD}, ${KEY}), (2, ${OLD}, null)`.execute(db());
  });

  describe('updatePasswordHash', () => {
    it('writes regardless without expected, and says so', async () => {
      expect(await writer().updatePasswordHash(1, NEW)).toBe(true);
      expect(await row(1)).toMatchObject({ password: NEW, session_key: KEY });
    });

    it('writes with a matching expected and leaves the hash alone otherwise', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { expected: 'other' as PasswordHash })).toBe(false);
      expect((await row(1)).password).toBe(OLD);
      expect(await writer().updatePasswordHash(1, NEW, { expected: OLD })).toBe(true);
      expect((await row(1)).password).toBe(NEW);
    });

    it('says false for an account that is gone', async () => {
      expect(await writer().updatePasswordHash(99, NEW)).toBe(false);
    });

    it('stores the session key in the same statement', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { sessionKey: NEXT_KEY })).toBe(true);
      expect(await row(1)).toMatchObject({ password: NEW, session_key: NEXT_KEY });
    });

    it('writes neither hash nor key when the expected hash does not match', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { expected: 'other' as PasswordHash, sessionKey: NEXT_KEY })).toBe(false);
      expect(await row(1)).toMatchObject({ password: OLD, session_key: KEY });
    });

    it('writes when expectedSessionKey is the stored key', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { sessionKey: NEXT_KEY, expectedSessionKey: KEY })).toBe(true);
      expect(await row(1)).toMatchObject({ password: NEW, session_key: NEXT_KEY });
    });

    it('writes neither hash nor key when expectedSessionKey is not the stored key', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { sessionKey: NEXT_KEY, expectedSessionKey: OTHER_KEY })).toBe(false);
      expect(await row(1)).toMatchObject({ password: OLD, session_key: KEY });
    });

    it('treats a null expectedSessionKey as "no key": matches an account without one only', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { sessionKey: NEXT_KEY, expectedSessionKey: null })).toBe(false);
      expect(await row(1)).toMatchObject({ password: OLD, session_key: KEY });
      expect(await writer().updatePasswordHash(2, NEW, { sessionKey: NEXT_KEY, expectedSessionKey: null })).toBe(true);
      expect(await row(2)).toMatchObject({ password: NEW, session_key: NEXT_KEY });
    });

    it('does not take a stored key for null, nor a key for a stored null', async () => {
      expect(await writer().updatePasswordHash(2, NEW, { sessionKey: NEXT_KEY, expectedSessionKey: KEY })).toBe(false);
      expect(await row(2)).toMatchObject({ password: OLD, session_key: null });
    });

    it('checks the hash and the key together', async () => {
      expect(await writer().updatePasswordHash(1, NEW, { expected: OLD, sessionKey: NEXT_KEY, expectedSessionKey: OTHER_KEY })).toBe(false);
      expect(await row(1)).toMatchObject({ password: OLD, session_key: KEY });
      expect(await writer().updatePasswordHash(1, NEW, { expected: OLD, sessionKey: NEXT_KEY, expectedSessionKey: KEY })).toBe(true);
    });

    it('refuses a session key of 31 characters and writes nothing, and takes one of 32', async () => {
      await expect(writer().updatePasswordHash(1, NEW, { sessionKey: 'x'.repeat(31) })).rejects.toThrow('at least 32');
      expect(await row(1)).toMatchObject({ password: OLD, session_key: KEY });
      expect(await writer().updatePasswordHash(1, NEW, { sessionKey: 'x'.repeat(32) })).toBe(true);
    });
  });

  describe('updateSessionKey', () => {
    it('compares and sets the key in one statement', async () => {
      expect(await writer().updateSessionKey(1, NEXT_KEY, OTHER_KEY)).toBe(false);
      expect((await row(1)).session_key).toBe(KEY);
      expect(await writer().updateSessionKey(1, NEXT_KEY, KEY)).toBe(true);
      expect((await row(1)).session_key).toBe(NEXT_KEY);
    });

    it('answers true for the stored key written over itself', async () => {
      expect(await writer().updateSessionKey(1, KEY, KEY)).toBe(true);
    });

    it('takes null as "no key", and undefined as "regardless"', async () => {
      expect(await writer().updateSessionKey(1, NEXT_KEY, null)).toBe(false);
      expect(await writer().updateSessionKey(2, NEXT_KEY, null)).toBe(true);
      expect(await writer().updateSessionKey(1, OTHER_KEY, undefined)).toBe(true);
      expect(await row(1)).toMatchObject({ session_key: OTHER_KEY });
    });

    it('refuses a key of 31 characters, and takes one of 32', async () => {
      await expect(writer().updateSessionKey(1, 'x'.repeat(31), undefined)).rejects.toThrow('at least 32');
      expect((await row(1)).session_key).toBe(KEY);
      expect(await writer().updateSessionKey(1, 'x'.repeat(32), undefined)).toBe(true);
    });
  });

  describe('updateEverySessionKey', () => {
    it('writes every account and names one that holds the key', async () => {
      const result = await writer().updateEverySessionKey(NEXT_KEY);
      expect(result.accounts).toBe(2);
      expect([1, 2]).toContain(result.sampleId);
      expect((await row(1)).session_key).toBe(NEXT_KEY);
      expect((await row(2)).session_key).toBe(NEXT_KEY);
    });

    it('answers no accounts and no sample for an empty table', async () => {
      await sql`delete from accounts`.execute(db());
      expect(await writer().updateEverySessionKey(NEXT_KEY)).toEqual({ accounts: 0, sampleId: undefined });
    });

    it('leaves updated_at alone: no account changed', async () => {
      await sql`update accounts set updated_at = 'sentinel'`.execute(db());
      await writer().updateEverySessionKey(NEXT_KEY);
      const rows = (await sql<{ updated_at: string }>`select updated_at from accounts`.execute(db())).rows;
      expect(rows.map((r) => r.updated_at)).toEqual(['sentinel', 'sentinel']);
    });

    it('refuses a key of 31 characters, and takes one of 32', async () => {
      await expect(writer().updateEverySessionKey('x'.repeat(31))).rejects.toThrow('at least 32');
      expect((await row(1)).session_key).toBe(KEY);
      expect((await writer().updateEverySessionKey('x'.repeat(32))).accounts).toBe(2);
    });
  });

  it('follows an enclosing transaction', async () => {
    await expect(
      db()
        .transaction()
        .execute(async (trx: any) => {
          await credentialWriter(trx, { table: 'accounts' }).updatePasswordHash(1, NEW);
          await trx.deleteFrom('accounts').where('id', '=', 2).execute();
          throw new Error('roll back');
        }),
    ).rejects.toThrow('roll back');
    expect((await row(1)).password).toBe(OLD);
    expect(await row(2)).toBeDefined();
  });

  it('joins the ambient transaction, so a write rolls back with it', async () => {
    const outside = writer();
    let wrote: boolean | undefined;
    await expect(
      connections.transaction(async () => {
        wrote = await outside.updatePasswordHash(1, NEW, { sessionKey: NEXT_KEY, expectedSessionKey: KEY });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(wrote).toBe(true);
    expect(await row(1)).toMatchObject({ password: OLD, session_key: KEY });
  });

  it('refuses a table name that is not a plain identifier', () => {
    for (const table of ['users; drop table users', 'Users', '"users"', 'a.b', '', '1users']) {
      expect(() => credentialWriter(db(), { table }), table).toThrow(TypeError);
    }
  });
});
