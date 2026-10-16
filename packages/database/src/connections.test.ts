import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { touchesSecrets } from './connections.ts';

const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});
const secrets = new Map([['users', new Set(['password'])]]);

describe('touchesSecrets', () => {
  it('flags a statement on a table with secret columns, in any case — SQLite reads USERS as users', () => {
    for (const table of ['users', 'Users', 'USERS']) {
      expect(touchesSecrets(db.updateTable(table).set({ password: 'hash' }).compile(), secrets), table).toBe(true);
      expect(touchesSecrets(db.selectFrom(table).select('id').compile(), secrets), table).toBe(true);
    }
  });

  it('flags a table of mixed case in the books too, and leaves other tables alone', () => {
    expect(touchesSecrets(db.selectFrom('users').select('id').compile(), new Map([['Users', new Set(['password'])]]))).toBe(true);
    expect(touchesSecrets(db.selectFrom('posts').select('id').compile(), secrets)).toBe(false);
    expect(touchesSecrets(db.selectFrom('users').select('id').compile(), new Map())).toBe(false);
  });

  it('flags raw SQL that names the table in any case', () => {
    expect(touchesSecrets(sql`select * from USERS`.compile(db), secrets)).toBe(true);
    expect(touchesSecrets(sql`select 1`.compile(db), secrets)).toBe(false);
  });
});
