import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { Connections, touchesSecrets } from './connections.ts';
import { silent } from './__fixtures__/databases.ts';
import { DatabaseConnectionError } from './driver.ts';
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

describe('a connection of a driver the types do not name', () => {
  const build = (driver: string, url: string) => () => new Connections({ connections: { default: { driver, url } as never }, root: '/', logger: silent });

  it('takes a mysql connection when the connections are built — it throws nothing, and a bad address only fails the first query', () => {
    expect(build('mysql', 'mysql://app:hunter2x@127.0.0.1/app')).not.toThrow();
  });

  it.each(['postgres://app:hunter2x@127.0.0.1/app', 'mysql:app:hunter2x@127.0.0.1/app', 'app:hunter2x@tcp(127.0.0.1)/app'])(
    'fails the first query of a mysql connection with an address that is no mysql:// URL, naming it as invalid and never the password: %s',
    async (url) => {
      const connections = build('mysql', url)();
      const error = await sql`select 1`.execute(connections.get()).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      expect((error as Error).message).toBe('[marmeon:D11] Could not connect to the database connection "default" (mysql (invalid URL)): The MySQL connection needs a mysql:// URL with a host.');
      expect((error as Error).message).not.toContain('hunter2x');
      await connections.destroy();
    },
  );

  it.each(['oracle', 'pgsql ', ''])('refuses the driver %j of a connection built without defineConnection with D29, and gives it no Postgres dialect', (driver) => {
    expect(build(driver, 'postgres://app@127.0.0.1/app')).toThrow(new UnsupportedDriverError(`[marmeon:D29] The database driver ${JSON.stringify(driver)} is not one Marmeon knows; use sqlite or pgsql.`));
  });
});
