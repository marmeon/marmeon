import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Generated } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp, type TestApp } from './index.ts';

interface FtsTables {
  articles: { id: Generated<number>; body: string };
}

const fts = defineModule({ name: 'fts', migrations: new URL('./__fixtures__/fts-migrations/', import.meta.url) });
const stale = defineModule({ name: 'fts-stale', migrations: new URL('./__fixtures__/fts-stale-migrations/', import.meta.url) });
const fts4 = defineModule({ name: 'fts4', migrations: new URL('./__fixtures__/fts4-migrations/', import.meta.url) });

/** The FTS5 tables of the fixture: external content (kept by triggers), own content, none, none with a quoted module name, and external content sorting before its table. */
const TABLES = ['articles_fts', 'notes_fts', 'tags_fts', 'Quoted fts', 'a_fts'] as const;

// SQLite only: FTS5 is an SQLite module.
describe('an app with FTS5 tables between test apps', () => {
  const env = { APP_KEY: generateKey(), DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' };
  let definition: ApplicationDefinition;
  beforeAll(() => {
    definition = { root: workspaceTempDir('marmeon-testing-fts-'), discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider], modules: [fts] };
  });

  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const open = async (database: 'refresh' | 'isolated') => (app = await createTestApp(definition, { env, database }));
  const db = () => app!.make(Connections).get<FtsTables>();
  const write = async (text: string) => {
    await db().insertInto('articles').values({ body: text }).execute();
    await sql`insert into notes_fts(body) values (${text})`.execute(db());
    await sql`insert into tags_fts(rowid, body) values (1, ${text})`.execute(db());
    await sql`insert into "Quoted fts"(rowid, body, extra) values (1, ${text}, ${text})`.execute(db());
    await sql`insert into z_docs(body) values (${text})`.execute(db());
    await sql`insert into a_fts(rowid, body) values (last_insert_rowid(), ${text})`.execute(db());
  };
  const matches = async (table: (typeof TABLES)[number], term: string) =>
    (await sql<{ rowid: number }>`select rowid from ${sql.id(table)} where ${sql.id(table)} match ${term}`.execute(db())).rows.map((row) => row.rowid);
  const intact = async (table: (typeof TABLES)[number]) => {
    await sql`insert into ${sql.id(table)}(${sql.id(table)}, rank) values('integrity-check', 1)`.execute(db());
  };

  it('starts every isolated app with empty, consistent FTS5 tables', async () => {
    await open('isolated');
    await write('marmalade');
    await app!.close();
    await open('isolated');
    await write('quince');
    await app!.close();
    await open('isolated');
    for (const table of TABLES) {
      expect(await matches(table, 'marmalade')).toEqual([]);
      expect(await matches(table, 'quince')).toEqual([]);
      await intact(table);
    }
    // The unindexed column lives in a shadow table that `delete-all` empties with the index.
    expect((await sql<{ count: number }>`select count(*) as count from "Quoted fts_content"`.execute(db())).rows[0]?.count).toBe(0);
    await write('apricot');
    for (const table of TABLES) expect(await matches(table, 'apricot')).toEqual([1]);
  });

  it('leaves a refreshed app after an isolated one an empty, consistent index', async () => {
    await open('isolated');
    await write('marmalade');
    await app!.close();
    await open('refresh');
    for (const table of TABLES) {
      expect(await matches(table, 'marmalade')).toEqual([]);
      await intact(table);
    }
    await app!.assertDatabaseCount<'articles', FtsTables>('articles', 0);
  });

  it('keeps the triggers of the content table in place', async () => {
    await open('isolated');
    await write('marmalade');
    await app!.close();
    await open('isolated');
    const { rows } = await sql<{ name: string }>`select name from sqlite_master where type = 'trigger' order by name`.execute(db());
    expect(rows.map((row) => row.name)).toEqual(['articles_ad', 'articles_ai', 'articles_au']);
    await write('quince');
    await db().deleteFrom('articles').execute();
    expect(await matches('articles_fts', 'quince')).toEqual([]);
    await intact('articles_fts');
  });

  it('refuses to start when an FTS5 index does not match its content after the emptying', async () => {
    const other: ApplicationDefinition = { ...definition, root: workspaceTempDir('marmeon-testing-fts-stale-'), modules: [stale] };
    await expect(createTestApp(other, { env, database: 'isolated' })).rejects.toThrow(/left the FTS5 table `stale_fts` with an index that does not match its content/);
  });

  it('still refuses an FTS4 table with external content, which it has no consistent way to empty', async () => {
    const other: ApplicationDefinition = { ...definition, root: workspaceTempDir('marmeon-testing-fts4-'), modules: [fts4] };
    await expect(createTestApp(other, { env, database: 'isolated' })).rejects.toThrow(/pages_fts_\w+ may not be modified/);
  });
});
