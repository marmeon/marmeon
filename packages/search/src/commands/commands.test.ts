import { CommandArgumentsError, type Application } from '@marmeon/core';
import { Connections, sql, type Connection, type Database } from '@marmeon/database';
import type { CommandInput } from 'marmeon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migratedApp } from '../__fixtures__/databases.ts';
import { SearchDriver } from '../driver.ts';
import type { Rebuilder, RebuildOptions, RebuildOutcome } from '../rebuild.ts';
import { SearchIndexes } from '../registry.ts';
import { SearchServiceProvider } from '../provider.ts';
import { Search } from '../search.ts';
import { SearchIndex, type SearchDocument, type SearchIndexClass } from '../search-index.ts';
import { SearchFlushCommand } from './flush.ts';
import { SearchRebuildCommand } from './rebuild.ts';

// The commands around a rebuild: their arguments, the protection of search:flush and a flush of a name no class declares.

interface PageRow {
  id: number;
  title: string;
}

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'title']);
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return { fields: { title: row.title } };
  }
}

class PostIndex extends SearchIndex<PageRow> {
  static readonly index = 'posts';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'title']);
  }

  toDocument(row: PageRow): SearchDocument<typeof PostIndex> {
    return { fields: { title: row.title } };
  }
}

const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closing.splice(0)) await close();
});

async function start(): Promise<{ app: Application; db: Connection<any> }> {
  const { app, close } = await migratedApp('sqlite', [PageIndex, PostIndex]);
  closing.push(close);
  return { app, db: app.container.make(Connections).get() };
}

/** Runs a command as `marmeon` would, with the lines it printed. */
async function command(app: Application, Command: typeof SearchRebuildCommand | typeof SearchFlushCommand, args: string[] = [], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { line: push(''), success: push('✓ '), warn: push('! '), error: push('✗ '), info: push('ℹ ') };
  const code = await app.container.make(Command).handle({ args, options, output, root: app.root } as unknown as CommandInput);
  return { code, lines };
}

const documents = async (db: Connection<any>) => (await sql<{ index_name: string }>`select index_name from search_documents order by id`.execute(db)).rows.map((row) => row.index_name);

describe('search:flush', () => {
  it('refuses in a protected environment without --force and removes nothing', async () => {
    const { app, db } = await start();
    await sql`insert into pages (id, slug, title, audience) values (1, 'a', 'A', 'public')`.execute(db);
    await app.container.make(Search).index(PageIndex, 1);
    vi.stubEnv('NODE_ENV', 'production');
    const { code, lines } = await command(app, SearchFlushCommand, ['pages']);
    expect(code).toBe(1);
    expect(lines).toContain(
      '✗ The application is protected (production (APP_ENV=production)). Pass --force to flush the search index "pages" — or, on a development machine, set NODE_ENV=development (in .env or the environment).',
    );
    expect(await documents(db)).toEqual(['pages']);

    const forced = await command(app, SearchFlushCommand, ['pages'], { force: true });
    expect(forced.code).toBe(0);
    expect(forced.lines).toContain('✓ Flushed the search index "pages".');
    expect(await documents(db)).toEqual([]);
  });

  it('flushes one index and leaves the others', async () => {
    const { app, db } = await start();
    await sql`insert into pages (id, slug, title, audience) values (1, 'a', 'A', 'public')`.execute(db);
    await app.container.make(Search).index(PageIndex, 1);
    await app.container.make(Search).index(PostIndex, 1);
    expect((await command(app, SearchFlushCommand, ['posts'])).code).toBe(0);
    expect(await documents(db)).toEqual(['pages']);
  });

  it('reaches the documents of a name no class declares any more, and says so', async () => {
    const { app, db } = await start();
    // Left behind by an index that was renamed.
    await sql`insert into search_documents (index_name, key) values ('old_pages', '1'), ('pages', '1')`.execute(db);
    const { code, lines } = await command(app, SearchFlushCommand, ['old_pages']);
    expect(code).toBe(0);
    expect(lines).toContain('! No index class declares "old_pages" (known: pages, posts); flushing the documents stored under that name.');
    expect(await documents(db)).toEqual(['pages']);
  });

  it('discards an unfinished rebuild of the index, so no resume brings the flushed documents back', async () => {
    const { app, db } = await start();
    await sql`insert into pages (id, slug, title, audience) values (1, 'a', 'A', 'public')`.execute(db);
    await sql`insert into search_rebuilds (index_name, run, phase, after, started_at) values ('pages', ${crypto.randomUUID()}, 'copy', '1', ${new Date().toISOString()})`.execute(db);
    await app.container.make(Search).index(PageIndex, 1);
    expect((await command(app, SearchFlushCommand, ['pages'])).code).toBe(0);
    expect((await sql`select * from search_rebuilds`.execute(db)).rows).toEqual([]);
    expect(await documents(db)).toEqual([]);
  });

  it('refuses while a rebuild of the index holds its lock, and removes nothing', async () => {
    const { app, db } = await start();
    await sql`insert into pages (id, slug, title, audience) values (1, 'a', 'A', 'public')`.execute(db);
    await app.container.make(Search).index(PageIndex, 1);
    const until = Date.now() + 60_000;
    await sql`insert into search_rebuilds (index_name, run, phase, holder, held_until, started_at) values ('pages', ${crypto.randomUUID()}, 'copy', 'other', ${until}, ${new Date().toISOString()})`.execute(db);
    const { code, lines } = await command(app, SearchFlushCommand, ['pages']);
    expect(code).toBe(1);
    expect(lines).toContain(`✗ A rebuild of "pages" holds its lock until ${new Date(until).toISOString()}. Flush the index once it has finished.`);
    expect(await documents(db)).toEqual(['pages']);
    expect((await sql`select holder from search_rebuilds`.execute(db)).rows).toEqual([{ holder: 'other' }]);
  });

  it('refuses a missing or malformed name and lists the known ones', async () => {
    const { app } = await start();
    const flush = vi.spyOn(app.container.make(SearchDriver), 'flush');
    await expect(command(app, SearchFlushCommand)).rejects.toThrow(new CommandArgumentsError('search:flush takes one index name (known: pages, posts).\nUsage: marmeon search:flush <index> [--force]'));
    await expect(command(app, SearchFlushCommand, ['Pages!'])).rejects.toThrow(new CommandArgumentsError('"Pages!" is no index name (known: pages, posts).'));
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('search:rebuild', () => {
  it('lists the known indexes for a name no class has, and rebuilds nothing', async () => {
    const { app, db } = await start();
    await expect(command(app, SearchRebuildCommand, ['page'])).rejects.toThrow(new CommandArgumentsError('No search index is named "page" (known: pages, posts).'));
    expect((await sql`select * from search_rebuilds`.execute(db)).rows).toEqual([]);
  });

  it('refuses a batch outside 1 to 500', async () => {
    const { app } = await start();
    for (const batch of ['0', '501', '1.5', 'ten', '']) {
      await expect(command(app, SearchRebuildCommand, [], { batch })).rejects.toThrow(new CommandArgumentsError('--batch is a whole number from 1 to 500.'));
    }
  });

  it('rebuilds every registered index without a name, one after another', async () => {
    const { app, db } = await start();
    await sql`insert into pages (id, slug, title, audience) values (1, 'a', 'A', 'public'), (2, 'b', 'B', 'public')`.execute(db);
    const { code, lines } = await command(app, SearchRebuildCommand, [], { batch: '1' });
    expect(code).toBe(0);
    expect(lines.filter((line) => !line.includes('done in'))).toEqual([
      'pages: 1 indexed, 0 removed',
      'pages: 2 indexed, 0 removed',
      'pages: 1 checked, 0 removed',
      'pages: 2 checked, 0 removed',
      'posts: 1 indexed, 0 removed',
      'posts: 2 indexed, 0 removed',
      'posts: 1 checked, 0 removed',
      'posts: 2 checked, 0 removed',
    ]);
    expect(await documents(db)).toEqual(['pages', 'pages', 'posts', 'posts']);
  });

  it('exits with 1 while another run holds the lock, and goes on with the other indexes', async () => {
    const { app, db } = await start();
    const until = Date.now() + 60_000;
    await sql`insert into search_rebuilds (index_name, run, phase, holder, held_until, started_at) values ('pages', ${crypto.randomUUID()}, 'copy', 'other', ${until}, ${new Date().toISOString()})`.execute(db);
    const { code, lines } = await command(app, SearchRebuildCommand);
    expect(code).toBe(1);
    expect(lines).toContain(`✗ Another rebuild of "pages" holds its lock until ${new Date(until).toISOString()}. Wait for it to finish; a run that stopped frees the lock then.`);
    expect(lines.some((line) => line.startsWith('posts: done in'))).toBe(true);
  });

  it.each([
    [[2, 'x'], '2 keys 2, "x"'],
    [[2], 'the key 2'],
    [Array.from({ length: 21 }, (_, i) => i + 1), `21 keys ${Array.from({ length: 20 }, (_, i) => i + 1).join(', ')} and 1 more`],
  ])('exits with 1 naming the keys a rebuild wrote no document for (%j), after it rebuilt the other indexes', async (failed, named) => {
    const { app } = await start();
    const calls: string[] = [];
    const rebuilder = {
      rebuild: async (Index: SearchIndexClass): Promise<RebuildOutcome> => {
        calls.push(Index.index);
        return Index.index === 'pages' ? { status: 'done', indexed: 1, removed: 0, failed } : { status: 'done', indexed: 3, removed: 0 };
      },
    } as unknown as Rebuilder;
    const lines: string[] = [];
    const output = { line: (line = '') => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const code = await new SearchRebuildCommand(app.container.make(SearchIndexes), rebuilder).handle({ args: [], options: {}, output } as unknown as CommandInput);
    expect(code).toBe(1);
    expect(calls).toEqual(['pages', 'posts']);
    expect(lines).toEqual([`✗ The rebuild of "pages" wrote no document for ${named}: the text is too long for the database (see the lines above).`]);
  });

  it('hands --batch and --fresh to the rebuild, and stops with 1 when a run loses its lock, before the next index', async () => {
    const { app } = await start();
    const calls: { index: string; batch: number; fresh: boolean }[] = [];
    const rebuilder = {
      rebuild: async (Index: SearchIndexClass, options: RebuildOptions): Promise<RebuildOutcome> => {
        calls.push({ index: Index.index, batch: options.batch, fresh: options.fresh });
        return { status: 'lost' };
      },
    } as unknown as Rebuilder;
    const lines: string[] = [];
    const output = { line: (line = '') => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const code = await new SearchRebuildCommand(app.container.make(SearchIndexes), rebuilder).handle({ args: [], options: { batch: '7', fresh: true }, output } as unknown as CommandInput);
    expect(code).toBe(1);
    expect(calls).toEqual([{ index: 'pages', batch: 7, fresh: true }]);
    expect(lines).toEqual(['✗ The rebuild of "pages" lost its lock to another run and stopped. That run goes on from the last saved batch.']);
  });

  it('says so when no index is registered', async () => {
    const { app, close } = await migratedApp('sqlite', []);
    closing.push(close);
    const { code, lines } = await command(app, SearchRebuildCommand);
    expect(code).toBe(0);
    expect(lines).toEqual(['No search index is registered: list index classes in a module’s searchIndexes or a provider’s static searchIndexes.']);
  });

  it('takes at most one name, and search:flush exactly one', async () => {
    const { app } = await start();
    await expect(command(app, SearchRebuildCommand, ['pages', 'posts'])).rejects.toThrow(
      new CommandArgumentsError('search:rebuild takes at most one index name.\nUsage: marmeon search:rebuild [index] [--batch=500] [--fresh]'),
    );
    await expect(command(app, SearchFlushCommand, ['pages', 'posts'])).rejects.toThrow(
      new CommandArgumentsError('search:flush takes one index name (known: pages, posts).\nUsage: marmeon search:flush <index> [--force]'),
    );
  });

  it('ends with the error of a row whose document cannot be built, and the next run goes on from there', async () => {
    const { app, db } = await start();
    await sql`insert into pages (id, slug, title, audience) values (1, 'a', 'A', 'public'), (2, 'b', ${'x'.repeat(10)}, 'public')`.execute(db);
    const failing = vi.spyOn(PageIndex.prototype, 'toDocument').mockImplementation((row: PageRow) => {
      if (row.id === 2) throw new TypeError('broken row');
      return { fields: { title: row.title } };
    });
    await expect(command(app, SearchRebuildCommand, ['pages'], { batch: '1' })).rejects.toThrow('broken row');
    failing.mockRestore();
    expect((await sql<{ after: string }>`select after from search_rebuilds`.execute(db)).rows).toEqual([{ after: '1' }]);
    const { code, lines } = await command(app, SearchRebuildCommand, ['pages'], { batch: '1' });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^pages: resuming the unfinished run started at /);
  });

  it('is registered by the provider together with search:flush', () => {
    expect(SearchServiceProvider.commands).toEqual([SearchRebuildCommand, SearchFlushCommand]);
  });
});
