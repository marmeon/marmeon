import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { drivers, freshConnections } from '../__fixtures__/databases.ts';
import { Migrator, Repository, type Connections } from '../index.ts';
import { planOf } from './plan.ts';
import { Blueprint } from './blueprint.ts';

interface Tables {
  ddl_pages: { id: Generated<number>; slug: string; locale: string; stage: string; note: string | null; deleted_at: Date | null };
}

class PageRepository extends Repository<'ddl_pages', Tables> {
  static table = 'ddl_pages' as const;
}

const root = workspaceTempDir('marmeon-partial-indexes-');
const modules: ModuleDefinition[] = [{ name: 'ddl', migrations: new URL('../__fixtures__/migrations/ddl/partial-indexes/', import.meta.url) }];

describe.each(drivers)('a partial unique index on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  it('lets two rows of another stage share the columns, and refuses the second live one', async () => {
    const pages = new PageRepository(connections);
    await pages.insert({ slug: 'a', locale: 'en', stage: 'draft' });
    await pages.insert({ slug: 'a', locale: 'en', stage: 'draft' });
    await pages.insert({ slug: 'a', locale: 'en', stage: 'live' });
    expect(await pages.tryInsert({ slug: 'a', locale: 'en', stage: 'live' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['slug', 'locale'] } });
    await pages.insert({ slug: 'a', locale: 'de', stage: 'live' });
  });

  it('is named by the repository as the duplicate: the columns of the index', async () => {
    const pages = new PageRepository(connections);
    await pages.insert({ slug: 'b', locale: 'en', stage: 'live' });
    expect(await pages.tryInsert({ slug: 'b', locale: 'en', stage: 'live' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['slug', 'locale'] } });
  });

  it('stores the condition of every index of the group as written', async () => {
    const db = connections.get();
    const rows =
      driver === 'sqlite'
        ? (await sql<{ name: string; text: string }>`select name, sql as text from sqlite_master where type = 'index' and tbl_name = 'ddl_pages' and sql is not null order by name`.execute(db)).rows
        : (await sql<{ name: string; text: string }>`select indexname as name, indexdef as text from pg_indexes where tablename = 'ddl_pages' order by indexname`.execute(db)).rows;
    const conditions = Object.fromEntries(rows.flatMap((row) => { const found = / where (.*)$/i.exec(row.text)?.[1]; return found === undefined ? [] : [[row.name, found.replaceAll('"', '')]]; }));
    const expected =
      driver === 'sqlite'
        ? {
            ddl_pages_alive: 'deleted_at is null',
            ddl_pages_featured_rank: 'featured = true and rank = 3',
            ddl_pages_featured_unique: 'featured = true',
            ddl_pages_noted: 'note is not null and featured = false',
            ddl_pages_quoted: "stage = 'it''s'",
            ddl_pages_slug_locale_unique: "stage = 'live'",
          }
        : {
            ddl_pages_alive: '(deleted_at IS NULL)',
            ddl_pages_featured_rank: '((featured = true) AND (rank = 3))',
            ddl_pages_featured_unique: '(featured = true)',
            ddl_pages_noted: '((note IS NOT NULL) AND (featured = false))',
            ddl_pages_quoted: "((stage)::text = 'it''s'::text)",
            ddl_pages_slug_locale_unique: "((stage)::text = 'live'::text)",
          };
    expect(conditions).toEqual(expected);
  });

  it('covers a boolean condition: two rows that match collide, a row that does not match does not', async () => {
    const db = connections.get();
    await sql`insert into ddl_pages (slug, locale, stage, featured) values ('only', 'en', 'draft', true)`.execute(db);
    await sql`insert into ddl_pages (slug, locale, stage, featured) values ('only', 'de', 'draft', false)`.execute(db);
    await expect(sql`insert into ddl_pages (slug, locale, stage, featured) values ('only', 'fr', 'draft', true)`.execute(db)).rejects.toThrow(/ddl_pages_featured_unique|ddl_pages\.slug/);
  });

  it('is dropped by Postgres with a column its condition uses, and refused by SQLite', async () => {
    const db = connections.get();
    const drop = sql`alter table ddl_pages drop column note`.execute(db);
    if (driver === 'sqlite') {
      await expect(drop).rejects.toThrow(/ddl_pages_noted/);
      return;
    }
    await drop;
    const left = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'ddl_pages' and indexname = 'ddl_pages_noted'`.execute(db);
    expect(left.rows).toEqual([]);
  });
});

describe('the condition of a partial index', () => {
  const index = (where: unknown) => () => {
    const blueprint = new Blueprint('pages');
    blueprint.index('slug', { where } as never);
  };

  it('is a map of columns to a string, a safe integer, a boolean, null or { not: null }', () => {
    expect(index({ stage: 'live', rank: 3, featured: false, deleted_at: null, note: { not: null } })).not.toThrow();
  });

  it.each([
    ['an empty condition', {}],
    ['no object', 'stage = 1'],
    ['an array', ['live']],
    ['undefined', { stage: undefined }],
    ['a fraction', { rank: 1.5 }],
    ['an unsafe integer', { rank: 2 ** 53 }],
    ['an infinite number', { rank: Infinity }],
    ['a NUL character', { stage: 'a\0b' }],
    ['a backslash', { stage: 'a\\b' }],
    ['a string that is too long', { stage: 'x'.repeat(256) }],
    ['an object other than { not: null }', { stage: { not: 'live' } }],
    ['{ not: null } with another key', { stage: { not: null, is: null } }],
    ['a date', { stage: new Date() }],
    ['a nested array', { stage: ['a'] }],
    ['a bigint', { rank: 3n }],
    ['a symbol', { rank: Symbol('x') }],
    ['a qualified column name', { 'pages.stage': 'live' }],
    ['a column name with a dot', { 'a.b': 'live' }],
  ])('refuses %s', (_, where) => {
    expect(index(where)).toThrow(/where. of an index on "pages"/);
  });

  it('says what it refuses without throwing on a value JSON cannot show', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(index({ rank: 3n })).toThrow('got 3n');
    expect(index({ rank: circular })).toThrow(/got object/);
  });

  describe('options', () => {
    const options = (value: unknown) => () => new Blueprint('pages').unique('slug', value as never);

    it.each([
      ['a map', new Map()],
      ['a date', new Date()],
      ['a class instance', new (class Options {})()],
    ])('refuse %s: they are a plain object', (_, value) => {
      expect(options(value)).toThrow(/of an index on "pages"/);
    });

    it('are a plain object, also one without a prototype', () => {
      expect(options(Object.assign(Object.create(null), { where: { stage: 'live' } }))).not.toThrow();
    });

    it.each([['an empty name', ''], ['a number', 5], ['null', null], ['a boolean', true]])('refuse %s as the name of the string form', (_, value) => {
      expect(() => new Blueprint('pages').index('slug', value as never)).toThrow(/index on "pages"/);
    });

    it('are a name and a where, and nothing else', () => {
      expect(options({ name: 'pages_live', where: { stage: 'live' } })).not.toThrow();
      expect(options({ name: 'pages_live' })).not.toThrow();
      expect(options({})).not.toThrow();
    });

    it.each([
      ['a misspelt key', { wehre: { stage: 'live' } }],
      ['a key in another case', { Where: { stage: 'live' } }],
      ['an array', ['x']],
      ['a name that is no string', { name: 5 }],
      ['an empty name', { name: '' }],
    ])('refuse %s, so that no index is made without its condition', (_, value) => {
      expect(options(value)).toThrow(/of an index on "pages"/);
    });
  });

  it('is part of the plan of a migration, frozen with it', () => {
    const steps = planOf({ up: (schema) => schema.create('pages', (t) => { t.id(); t.string('stage'); t.unique('stage', { where: { stage: 'live' } }); }) }, 'up');
    const step = steps[0] as { blueprint: Blueprint };
    expect(step.blueprint.allIndexes()).toEqual([{ columns: ['stage'], unique: true, name: 'pages_stage_unique', where: { stage: 'live' } }]);
    expect(Object.isFrozen(step.blueprint.allIndexes()[0]!.where)).toBe(true);
  });
});
