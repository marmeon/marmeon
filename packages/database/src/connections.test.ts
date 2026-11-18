import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { Connections, touchesSecrets } from './connections.ts';
import { silent } from './__fixtures__/databases.ts';
import { UnsupportedDriverError } from './supported-driver.ts';

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

describe('a connection of a driver that does not run yet', () => {
  const build = (driver: string, url: string) => () => new Connections({ connections: { default: { driver, url } as never }, root: '/', logger: silent });

  it.each([
    ['mysql://app:hunter2x@127.0.0.1/app', 'mysql mysql://app:***@127.0.0.1/app'],
    ['postgres://app:hunter2x@127.0.0.1/app', 'mysql (invalid URL)'],
    ['mysql:app:hunter2x@127.0.0.1/app', 'mysql (invalid URL)'],
    ['app:hunter2x@tcp(127.0.0.1)/app', 'mysql (invalid URL)'],
  ])('refuses mysql when the connections are built, naming the masked target of %s', (url, described) => {
    const construct = build('mysql', url);
    expect(construct).toThrow(UnsupportedDriverError);
    expect(construct).toThrow(new UnsupportedDriverError(`[marmeon:D29] The connection "default" (${described}) does not run on MySQL yet.`));
    expect(construct).not.toThrow(/hunter2x/);
  });

  it.each(['oracle', 'pgsql ', ''])('refuses the driver %j of a connection built without defineConnection with D29, and gives it no Postgres dialect', (driver) => {
    expect(build(driver, 'postgres://app@127.0.0.1/app')).toThrow(new UnsupportedDriverError(`[marmeon:D29] The database driver ${JSON.stringify(driver)} is not one Marmeon knows; use sqlite or pgsql.`));
  });
});
