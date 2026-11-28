import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Redactor, type Application } from '@marmeon/core';
import { Output } from 'marmeon';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbQueryCommand } from './commands/db-query.ts';
import { Connections } from './connections.ts';
import { declareDerivedSchema, derivedSchemaOf } from './derived-schema.ts';
import { drivers, freshDatabase, silent, type TestDriver } from './__fixtures__/databases.ts';
import { inspectionConnection } from './migrator-connection.ts';
import { Migrator, type UnknownSchema } from './migrations/migrator.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const appOf = (modules: unknown[], root: string) => ({ modules, root }) as unknown as Application;

describe('declareDerivedSchema', () => {
  it('keeps the entries of each app apart and merges the owners of one', () => {
    const one = appOf([], '/');
    const other = appOf([], '/');
    declareDerivedSchema(one, 'search', { tables: ['docs_fts'], columns: { docs: ['vector'] } });
    declareDerivedSchema(one, 'tags', { columns: { docs: ['tag_vector'], posts: ['vector'] } });
    expect(derivedSchemaOf(one, 'default')).toEqual({ tables: new Set(['docs_fts']), columns: new Map([['docs', new Set(['vector', 'tag_vector'])], ['posts', new Set(['vector'])]]) });
    expect(derivedSchemaOf(other, 'default')).toEqual({ tables: new Set(), columns: new Map() });
  });

  it('keeps the entries of each connection apart, default when none is named', () => {
    const app = appOf([], '/');
    declareDerivedSchema(app, 'search', { tables: ['docs_fts'] });
    declareDerivedSchema(app, 'reports', { connection: 'analytics', tables: ['reports_fts'] });
    expect(derivedSchemaOf(app, 'default').tables).toEqual(new Set(['docs_fts']));
    expect(derivedSchemaOf(app, 'analytics').tables).toEqual(new Set(['reports_fts']));
    expect(derivedSchemaOf(app, 'other').tables).toEqual(new Set());
  });

  it('replaces the entry of an owner that declares again', () => {
    const app = appOf([], '/');
    declareDerivedSchema(app, 'search', { tables: ['docs_fts'] });
    declareDerivedSchema(app, 'search', { tables: ['pages_fts'] });
    expect(derivedSchemaOf(app, 'default').tables).toEqual(new Set(['pages_fts']));
  });

  it.each([
    ['an empty table name', { tables: [''] }],
    ['a qualified table name', { tables: ['public.docs'] }],
    ['a pattern', { tables: ['docs_%'] }],
    ['a name with a dash', { tables: ['docs-fts'] }],
    ['a name that starts with a digit', { tables: ['1docs'] }],
    ['a name over 63 characters', { tables: [`a${'b'.repeat(63)}`] }],
    ['a quoted name', { tables: ['"docs"'] }],
    ['a name with a control character', { tables: ['docs‮'] }],
    ['a table of columns that is no identifier', { columns: { 'docs fts': ['vector'] } }],
    ['a column that is no identifier', { columns: { docs: ['vector;'] } }],
    ['a name that is not a string', { tables: [42 as unknown as string] }],
    ['tables that are not an array', { tables: 'docs_fts' as unknown as string[] }],
    ['columns that are not an array', { columns: { docs: 'vector' as unknown as string[] } }],
    ['an unknown key', { table: ['docs_fts'] } as unknown as { tables: string[] }],
    ['an empty connection', { connection: '', tables: ['docs_fts'] }],
    ['a connection that is not a string', { connection: 1 as unknown as string, tables: ['docs_fts'] }],
  ])('throws on %s, and declares nothing', (_what, entry) => {
    const app = appOf([], '/');
    expect(() => declareDerivedSchema(app, 'search', entry)).toThrow(TypeError);
    expect(derivedSchemaOf(app, 'default')).toEqual({ tables: new Set(), columns: new Map() });
  });

  it('accepts a name of 63 characters', () => {
    const app = appOf([], '/');
    const name = `_${'a'.repeat(62)}`;
    declareDerivedSchema(app, 'search', { tables: [name] });
    expect(derivedSchemaOf(app, 'default').tables).toEqual(new Set([name]));
  });

  it('writes a control character of the name out instead of passing it to the terminal', () => {
    expect(() => declareDerivedSchema(appOf([], '/'), 'search', { tables: ['docs‮'] })).toThrow('"docs\\u202e"');
  });
});

/** A migration as a framework package would ship it: a blueprint table, then what the blueprint cannot write as raw SQL. */
const migration = `import { defineMigration, sql } from '${new URL('./index.ts', import.meta.url).href}';
export default defineMigration({
  up: (schema) => {
    schema.create('search_documents', (table) => { table.id(); table.text('body').nullable(); });
    schema.raw({ sqlite: sql\`create virtual table search_documents_fts using fts5(body, content='search_documents', content_rowid='id')\`, mysql: null });
    schema.raw({ sqlite: sql\`create trigger search_documents_ai after insert on search_documents begin insert into search_documents_fts(rowid, body) values (new.id, new.body); end\`, mysql: null });
    schema.raw({ pgsql: sql\`alter table search_documents add column vector tsvector not null default ''::tsvector\`, mysql: null });
  },
  down: (schema) => {
    schema.raw({ sqlite: sql\`drop table search_documents_fts\`, mysql: null });
    schema.drop('search_documents');
  },
});
`;

const SHADOWS = ['search_documents_fts', 'search_documents_fts_config', 'search_documents_fts_data', 'search_documents_fts_docsize', 'search_documents_fts_idx'];

describe.each(drivers)('the derived schema of a framework package on %s', (driver: TestDriver) => {
  let connections: Connections;
  let modules: unknown[];
  let directory: string;
  let drop = async () => {};
  const declared = (other?: { tables?: string[]; columns?: Record<string, string[]> }) => {
    const app = appOf(modules, directory);
    declareDerivedSchema(app, 'search', { tables: ['search_documents_fts'], columns: { search_documents: ['vector'] } });
    if (other) declareDerivedSchema(app, 'other', other);
    return app;
  };
  const unknownAfterMigrate = async (app: Application) => {
    const found: UnknownSchema[] = [];
    await new Migrator(app, connections).migrate({ onUnknown: (_, schema) => found.push({ tables: schema.tables.toSorted(), columns: schema.columns }) });
    return found;
  };
  const exec = (statement: string) => sql.raw(statement).execute(inspectionConnection(connections));

  beforeAll(async () => {
    directory = workspaceTempDir('marmeon-derived-schema-');
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '2026_01_01_000000_create_search_documents_table.ts'), migration);
    modules = [{ name: 'search', migrations: pathToFileURL(`${migrations}/`) }];
    const database = driver === 'sqlite' ? { options: { driver: 'sqlite' as const, database: join(directory, 'app.db') }, drop: async () => {} } : await freshDatabase('pgsql');
    drop = database.drop;
    connections = new Connections({ connections: { default: database.options }, root: directory, logger: silent });
  });
  afterAll(async () => {
    await connections.destroy();
    await drop();
  });

  it('is named by migrate without a declaration: the FTS5 table and its shadow tables on SQLite, the vector column on Postgres', async () => {
    const found = await unknownAfterMigrate(appOf(modules, directory));
    expect(found).toEqual(driver === 'sqlite' ? [{ tables: SHADOWS, columns: [] }] : [{ tables: [], columns: ['search_documents.vector'] }]);
  });

  it('is not named by migrate once the package declares it', async () => {
    expect(await unknownAfterMigrate(declared())).toEqual([]);
  });

  it('still names a table that only looks like a shadow table, and on Postgres the FTS5 names', async () => {
    const lookalike = driver === 'sqlite' ? 'search_documents_fts_extra' : 'search_documents_fts_data';
    await exec(`create table ${lookalike} (x integer)`);
    await exec('create table search_documents_ftsx_data (x integer)');
    try {
      expect(await unknownAfterMigrate(declared())).toEqual([{ tables: [lookalike, 'search_documents_ftsx_data'].toSorted(), columns: [] }]);
    } finally {
      await exec(`drop table ${lookalike}`);
      await exec('drop table search_documents_ftsx_data');
    }
  });

  it('still names a table named like a shadow table of a declared plain table', async () => {
    await exec('create table search_cache (x integer)');
    await exec('create table search_cache_data (x integer)');
    try {
      expect(await unknownAfterMigrate(declared({ tables: ['search_cache'] }))).toEqual([{ tables: ['search_cache_data'], columns: [] }]);
    } finally {
      await exec('drop table search_cache_data');
      await exec('drop table search_cache');
    }
  });

  it.runIf(driver === 'sqlite')('leaves out the content shadow table of a declared FTS5 table that keeps its own content', async () => {
    await exec('create virtual table search_notes_fts using fts5(body)');
    try {
      const notes = SHADOWS.slice(1).map((name) => name.replace('search_documents_fts', 'search_notes_fts'));
      expect(await unknownAfterMigrate(declared())).toEqual([{ tables: ['search_notes_fts', 'search_notes_fts_content', ...notes].toSorted(), columns: [] }]);
      expect(await unknownAfterMigrate(declared({ tables: ['search_notes_fts'] }))).toEqual([]);
    } finally {
      await exec('drop table search_notes_fts');
    }
  });

  it('names a column the package did not declare, and leaves it out once declared', async () => {
    await exec('alter table search_documents add column other integer');
    try {
      expect(await unknownAfterMigrate(declared())).toEqual([{ tables: [], columns: ['search_documents.other'] }]);
      expect(await unknownAfterMigrate(declared({ columns: { search_documents: ['other'] } }))).toEqual([]);
    } finally {
      await exec('alter table search_documents drop column other');
    }
  });

  it('stays withheld from db:query with the declaration in place', async () => {
    const app = declared();
    const query = async (statement: string) => {
      const stderr: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
      try {
        const code = await new DbQueryCommand(connections, new Migrator(app, connections), new Redactor()).handle({ args: [statement], options: { json: true }, output: new Output(), root: '/' } as never);
        return { code, stderr: stderr.join('') };
      } finally {
        vi.restoreAllMocks();
      }
    };
    await exec("insert into search_documents (body) values ('derived-body-marker')");
    expect((await query('select id from search_documents')).code).toBe(0);
    const refused = await query(driver === 'sqlite' ? 'select * from search_documents_fts' : 'select vector from search_documents');
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('No migration describes it');
    expect(refused.stderr).not.toContain('derived-body-marker');
  });

  it('is dropped by migrate:fresh without an error, and made again', async () => {
    await exec("insert into search_documents (body) values ('before fresh')");
    await new Migrator(declared(), connections).fresh();
    expect(Number((await sql<{ n: number | string }>`select count(*) as n from search_documents`.execute(inspectionConnection(connections))).rows[0]!.n)).toBe(0);
    const tables = (await sql<{ name: string }>`${sql.raw(driver === 'sqlite' ? "select name from sqlite_master where type = 'table' and name like 'search%'" : "select tablename as name from pg_tables where schemaname = 'public' and tablename like 'search%'")}`.execute(inspectionConnection(connections))).rows.map((row) => row.name);
    expect(tables.toSorted()).toEqual(driver === 'sqlite' ? ['search_documents', ...SHADOWS].toSorted() : ['search_documents']);
  });
});

describe('the derived schema of a framework package on two SQLite connections', () => {
  const module = (connection: string, table: string) => `import { defineMigration } from '${new URL('./index.ts', import.meta.url).href}';
export default defineMigration({ connection: '${connection}', up: (schema) => schema.create('${table}', (table) => { table.id(); }), down: (schema) => schema.drop('${table}') });
`;

  it('leaves a declared table out on its own connection only: a table of the same name on another connection is still named', async () => {
    const directory = workspaceTempDir('marmeon-derived-schema-');
    const modules: { name: string; migrations: URL }[] = [];
    for (const [name, connection, table] of [['search', 'default', 'search_documents'], ['analytics', 'other', 'events']] as const) {
      const migrations = join(directory, name);
      mkdirSync(migrations);
      writeFileSync(join(migrations, `2026_01_0${modules.length + 1}_000000_create_${table}_table.ts`), module(connection, table));
      modules.push({ name, migrations: pathToFileURL(`${migrations}/`) });
    }
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'app.db') }, other: { driver: 'sqlite', database: join(directory, 'other.db') } }, root: directory, logger: silent });
    try {
      await new Migrator(appOf(modules, directory), connections).migrate();
      for (const name of ['default', 'other']) await sql`create table search_documents_raw (x integer)`.execute(inspectionConnection(connections, name));
      const unknownAfterMigrate = async (connection?: string) => {
        const app = appOf(modules, directory);
        declareDerivedSchema(app, 'search', { ...(connection ? { connection } : {}), tables: ['search_documents_raw'] });
        const found: [string, readonly string[]][] = [];
        await new Migrator(app, connections).migrate({ onUnknown: (name, schema) => found.push([name, schema.tables]) });
        return found;
      };
      expect(await unknownAfterMigrate()).toEqual([['other', ['search_documents_raw']]]);
      expect(await unknownAfterMigrate('other')).toEqual([['default', ['search_documents_raw']]]);
    } finally {
      await connections.destroy();
    }
  });
});
