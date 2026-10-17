import { readFileSync } from 'node:fs';
import { createApplication, env } from '@marmeon/core';
import { Output } from 'marmeon';
import { CompiledQuery, Kysely, PostgresAdapter, PostgresQueryCompiler, sql, type DatabaseIntrospector, type Driver, type QueryResult, type TableMetadata } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbShowCommand } from './commands/db-show.ts';
import { Connections, DatabaseServiceProvider, defineConnection } from './index.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/formats/cli-db-show/${name}.json`, import.meta.url), 'utf8'));
}

/** A Postgres-shaped connection that needs no server: a version, two tables in `public`, 7 rows each. */
function fakePostgres(): Kysely<any> {
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => ({
      executeQuery: async (query: CompiledQuery): Promise<QueryResult<any>> => ({ rows: query.sql.includes('version()') ? [{ v: 'PostgreSQL 16.2 on x86_64-pc-linux-gnu' }] : [{ count: '7' }] }),
      streamQuery: async function* () {},
    }),
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const column = (name: string) => ({ name, dataType: 'text', isNullable: true, isAutoIncrementing: false, hasDefaultValue: false });
  const tables: TableMetadata[] = [
    { name: 'users', schema: 'public', isView: false, isForeign: false, columns: [column('id'), column('name'), column('email')] },
    { name: 'posts', schema: 'public', isView: false, isForeign: false, columns: [column('id'), column('title')] },
  ];
  const introspector: DatabaseIntrospector = {
    getSchemas: async () => [],
    getTables: async () => tables,
  };
  return new Kysely<any>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: () => introspector, createQueryCompiler: () => new PostgresQueryCompiler() } });
}

const Reporting = defineConnection('reporting', {
  env: env({ REPORTING_PASSWORD: env.string() }),
  resolve: (e) => ({ driver: 'pgsql', host: 'reports.internal', database: 'reports', username: 'analyst', password: e.REPORTING_PASSWORD }),
});

async function show(vars: Record<string, string>, options: Record<string, string | boolean> = {}) {
  const app = await createApplication({ root: tempDir('marmeon-db-show-'), discover: false, config: [Reporting], providers: [DatabaseServiceProvider] }, { env: { REPORTING_PASSWORD: 'unused', ...vars } });
  const connections = app.container.make(Connections);
  const db = fakePostgres();
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
  const command = new DbShowCommand({ options: (name?: string) => connections.options(name), get: () => db } as unknown as Connections);
  const code = await command.handle({ args: [], options, output: new Output(), root: '/' } as never);
  vi.restoreAllMocks();
  await app.shutdown();
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

afterEach(() => vi.restoreAllMocks());

const POSTGRES = { DB_CONNECTION: 'pgsql' };

describe('db:show --json', () => {
  it('prints one document for a SQLite database, matching the stored format', async () => {
    const app = await createApplication({ root: tempDir('marmeon-db-show-'), discover: false, providers: [DatabaseServiceProvider] }, { env: { DB_DATABASE: ':memory:' } });
    const connections = app.container.make(Connections);
    await sql`create table notes (id integer primary key, body text)`.execute(connections.get());
    await sql`insert into notes (body) values ('a'), ('b')`.execute(connections.get());
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
    const code = await new DbShowCommand(connections).handle({ args: [], options: { json: true }, output: new Output(), root: '/' } as never);
    vi.restoreAllMocks();
    await app.shutdown();

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out.endsWith('\n')).toBe(true);
    const document = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(['format', 'connection', 'driver', 'target', 'server', 'tables', 'warnings']);
    expect(document.server).toMatch(/^SQLite \d+\.\d+\.\d+/);
    const expected = fixture('v1');
    expect({ ...document, server: expected.server }).toMatchObject(expected);
    expect((document.tables as object[]).map((table) => Object.keys(table))).toEqual([['name', 'schema', 'columns', 'rows']]);
  });

  it('prints a Postgres database with the schema of each table, matching the stored format', async () => {
    const { code, stdout, stderr } = await show({ ...POSTGRES, DB_URL: 'postgres://app:geheim@db.internal:5433/shop?sslmode=require' }, { json: true });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const document = JSON.parse(stdout) as Record<string, unknown>;
    expect(document).toMatchObject(fixture('v1-pgsql'));
    expect((document.tables as object[]).map((table) => Object.keys(table))).toEqual(Array(2).fill(['name', 'schema', 'columns', 'rows']));
  });

  it('prints an empty database as an empty list', async () => {
    const app = await createApplication({ root: tempDir('marmeon-db-show-'), discover: false, providers: [DatabaseServiceProvider] }, { env: { DB_DATABASE: ':memory:' } });
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
    await new DbShowCommand(app.container.make(Connections)).handle({ args: [], options: { json: true }, output: new Output(), root: '/' } as never);
    vi.restoreAllMocks();
    await app.shutdown();
    expect(JSON.parse(stdout.join('')).tables).toEqual([]);
  });

  it('prints the text without --json, with the driver in front of the target', async () => {
    const { stdout } = await show({ ...POSTGRES, DB_URL: 'postgres://app:geheim@db.internal/shop' });
    expect(stdout).toContain('Target      pgsql postgres://app:***@db.internal/shop');
    expect(stdout).toContain('public.users');
  });
});

// The document lands in CI logs and agent transcripts: nothing of a connection's secrets may reach stdout or stderr, in
// text or JSON, whichever way the password was configured.
describe('db:show never prints a secret of the connection', () => {
  const secrets = ['geheim', 'geheim2', 'geheim3', 'p@ss/word', 'p%40ss%2Fword', 'sslkey', '/x', 'keys', 'sslpassword', 'sslcert', 'options'];

  const cases: Record<string, { vars: Record<string, string>; options?: Record<string, string> }> = {
    'user:password@ and a password and a key path in the query': { vars: { DB_URL: 'postgres://u:geheim@h/db?sslkey=/x&password=geheim2' } },
    'a percent-encoded password': { vars: { DB_URL: 'postgres://u:p%40ss%2Fword@h/db' } },
    'a password with no user name': { vars: { DB_URL: 'postgresql://:geheim@h/db' } },
    'the password parameter in other case, and a fragment': { vars: { DB_URL: 'postgres://u@h/db?PassWord=geheim2&SSLKey=/x#geheim3' } },
    'ssl parameters of every kind': { vars: { DB_URL: 'postgres://u:geheim@h/db?sslmode=require&sslrootcert=/keys/ca.pem&sslcert=/keys/c.pem&sslpassword=geheim2&options=-c%20x' } },
    'DB_PASSWORD in parts': { vars: { DB_HOST: 'h', DB_USERNAME: 'u', DB_PASSWORD: 'p@ss/word', DB_DATABASE: 'db' } },
    'a password option of another connection': { vars: { REPORTING_PASSWORD: 'geheim' }, options: { database: 'reporting' } },
  };

  for (const [name, { vars, options }] of Object.entries(cases)) {
    for (const json of [true, false]) {
      it(`${name} (${json ? 'json' : 'text'})`, async () => {
        const { code, stdout, stderr } = await show({ ...POSTGRES, ...vars }, { ...options, ...(json ? { json: true } : {}) });
        expect(code).toBe(0);
        for (const secret of secrets) {
          expect(stdout, secret).not.toContain(secret);
          expect(stderr, secret).not.toContain(secret);
        }
        if (json) expect(JSON.parse(stdout).target).toMatch(/^postgres(ql)?:\/\//);
      });
    }
  }

  it('a SQLite database prints its file and nothing else', async () => {
    const app = await createApplication({ root: tempDir('marmeon-db-show-'), discover: false, providers: [DatabaseServiceProvider] }, { env: { DB_DATABASE: ':memory:' } });
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
    await new DbShowCommand(app.container.make(Connections)).handle({ args: [], options: { json: true }, output: new Output(), root: '/' } as never);
    vi.restoreAllMocks();
    await app.shutdown();
    expect(JSON.parse(stdout.join('')).target).toBe(':memory:');
  });
});
