import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { MARKERS_TABLE, Migrator, type Connections } from './index.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'drafts', migrations: fixtures('markers') },
];

describe.each(drivers)('schema markers on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const migrator = () => new Migrator({ modules, root: '/' } as unknown as Application, connections);
  const markers = async () => (await migrator().markers()).map((m) => [m.table, m.column, m.marker, m.value]);
  const users = [
    ['users', '', 'soft_deletes', null],
    ['users', '', 'timestamps', null],
  ];

  beforeAll(async () => ({ connections, close } = await freshConnections(driver)));
  afterAll(() => close());

  it('records soft deletes, timestamps and inverse names in a bookkeeping table of their own', async () => {
    await migrator().migrate();
    expect(MARKERS_TABLE).toBe('schema_markers');
    expect((await connections.get<any>().introspection.getTables()).map((t) => t.name)).toContain('schema_markers');
    // After the last migration: `drafts` renamed to `notes`, `writer_id` to `author_id`, `deleted_at` dropped.
    expect(await markers()).toEqual([
      ['notes', '', 'timestamps', null],
      ['notes', 'author_id', 'inverse', 'written_drafts'],
      ...users,
    ]);
  });

  it('brings a table-level marker back with its column', async () => {
    await migrator().rollback({ steps: 1 });
    expect(await markers()).toEqual([
      ['notes', '', 'soft_deletes', null],
      ['notes', '', 'timestamps', null],
      ['notes', 'author_id', 'inverse', 'written_drafts'],
      ...users,
    ]);
  });

  it('follows a renamed table and a renamed column', async () => {
    await migrator().rollback({ steps: 1 });
    expect(await markers()).toEqual([
      ['drafts', '', 'soft_deletes', null],
      ['drafts', '', 'timestamps', null],
      ['drafts', 'writer_id', 'inverse', 'written_drafts'],
      ...users,
    ]);
  });

  it('forgets every marker of a dropped table', async () => {
    await migrator().rollback({ steps: 1 });
    expect(await markers()).toEqual(users);
  });
});
