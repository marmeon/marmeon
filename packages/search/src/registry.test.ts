import { createApplication, type Application, type ModuleDefinition, type ServiceProviderClass } from '@marmeon/core';
import type { Connection, Database } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { SearchSetupError } from './errors.ts';
import { SearchServiceProvider } from './provider.ts';
import { SearchIndexes } from './registry.ts';
import { SearchIndex, type AnyDocument } from './search-index.ts';

// Index classes come from modules and providers; the start checks each definition exactly and stops with Q9, naming the class and
// where it was listed.

interface PageRow {
  id: number;
  title: string;
  body: string;
  kind: string;
}

abstract class PageRows extends SearchIndex<PageRow> {
  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').selectAll();
  }

  toDocument(row: PageRow): AnyDocument {
    return { fields: { title: row.title, body: row.body }, filters: { kind: row.kind } };
  }
}

class PageIndex extends PageRows {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A', body: 'C' } as const;
  static readonly filters = ['kind'] as const;
}

class PostIndex extends PageRows {
  static readonly index = 'posts';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;
}

/** A subclass of PageIndex named `name` whose statics are `statics` (an `undefined` hides the inherited one). */
function variant(name: string, statics: Record<string, unknown>): typeof PageIndex {
  const Index = { [name]: class extends PageIndex {} }[name]!;
  for (const [key, value] of Object.entries(statics)) Object.defineProperty(Index, key, { value, configurable: true });
  return Index;
}

const provider = (name: string, searchIndexes: unknown): ServiceProviderClass =>
  ({ [name]: class { static searchIndexes = searchIndexes; boot(): void {} } })[name] as unknown as ServiceProviderClass;

function boot(options: { modules?: ModuleDefinition[]; providers?: ServiceProviderClass[] }): Promise<Application> {
  return createApplication(
    { root: import.meta.dirname, discover: false, providers: [SearchServiceProvider, ...(options.providers ?? [])], modules: options.modules ?? [] },
    { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } },
  );
}

const inModule = (...searchIndexes: unknown[]) => boot({ modules: [{ name: 'pages', searchIndexes: searchIndexes as never }] });

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(() => undefined, (caught: unknown) => caught)) as Error;
  expect(error).toBeInstanceOf(SearchSetupError);
  return error.message;
}

describe('SearchIndexes: indexes from modules and providers', () => {
  it('collects the indexes of a module and of a provider, and hands out their classes and frozen infos', async () => {
    const app = await boot({ modules: [{ name: 'pages', searchIndexes: [PageIndex] }], providers: [provider('BlogServiceProvider', [PostIndex])] });
    const indexes = app.container.make(SearchIndexes);
    expect(indexes.all()).toEqual([PageIndex, PostIndex]);
    expect(indexes.get('pages')).toBe(PageIndex);
    expect(indexes.get('posts')).toBe(PostIndex);
    expect(indexes.get('nope')).toBeUndefined();
    const info = indexes.info(PageIndex);
    expect(info).toEqual({ name: 'pages', key: 'id', fields: [{ name: 'title', weight: 'A' }, { name: 'body', weight: 'C' }], filters: ['kind'] });
    expect(Object.isFrozen(info) && Object.isFrozen(info.fields) && Object.isFrozen(info.fields[0]) && Object.isFrozen(info.filters)).toBe(true);
  });

  it('collects the indexes of a provider a module lists', async () => {
    const app = await boot({ modules: [{ name: 'blog', providers: [provider('BlogProvider', [PostIndex])] }] });
    expect(app.container.make(SearchIndexes).all()).toEqual([PostIndex]);
  });

  it('keeps what it checked at the start when a static changes later', async () => {
    const Index = variant('LaterIndex', {});
    const app = await inModule(Index);
    Object.defineProperty(Index, 'index', { value: 'Not A Name', configurable: true });
    Object.defineProperty(Index, 'fields', { value: { secret_column: 'A' }, configurable: true });
    expect(app.container.make(SearchIndexes).info(Index)).toMatchObject({ name: 'pages', fields: [{ name: 'title', weight: 'A' }, { name: 'body', weight: 'C' }] });
  });

  it('counts the same class twice as one index, from one list, two modules or a module and a provider', async () => {
    const app = await boot({
      modules: [
        { name: 'pages', searchIndexes: [PageIndex, PageIndex] },
        { name: 'more', searchIndexes: [PageIndex] },
      ],
      providers: [provider('PagesProvider', [PageIndex])],
    });
    expect(app.container.make(SearchIndexes).all()).toEqual([PageIndex]);
  });

  it('takes an index without filters and with connection default', async () => {
    const Index = variant('PlainIndex', { filters: undefined, connection: 'default' });
    const app = await inModule(Index);
    expect(app.container.make(SearchIndexes).info(Index).filters).toEqual([]);
  });

  it('refuses the info of a class that is not registered with a TypeError', async () => {
    const app = await inModule(PageIndex);
    expect(() => app.container.make(SearchIndexes).info(PostIndex)).toThrow(new TypeError('PostIndex is not a registered search index. List it in a module\'s searchIndexes or a provider\'s static searchIndexes.'));
  });
});

describe('SearchIndexes: the start refuses a broken definition with Q9', () => {
  it('refuses a name two different classes share, naming both classes and where they come from', async () => {
    const Twin = variant('TwinIndex', { index: 'pages' });
    expect(await refusal(boot({ modules: [{ name: 'pages', searchIndexes: [PageIndex] }], providers: [provider('CmsServiceProvider', [Twin])] }))).toBe(
      '[marmeon:Q9] Two search indexes are named "pages": PageIndex (module pages) and TwinIndex (provider CmsServiceProvider). The name is how the index is stored — give each its own static index.',
    );
  });

  it.each([
    ['Pages', '"Pages"'],
    ['1pages', '"1pages"'],
    ['pa ges', '"pa ges"'],
    ['', '""'],
    ['p'.repeat(65), `"${'p'.repeat(65)}"`],
    [undefined, 'undefined'],
    [42, 'a number'],
  ])('refuses the index name %j', async (name, shown) => {
    expect(await refusal(inModule(variant('BadNameIndex', { index: name })))).toBe(
      `[marmeon:Q9] BadNameIndex (module pages) has static index = ${shown}, but an index name is lowercase letters, digits, "_" and "-", starting with a letter, at most 64 characters: static index = 'pages'.`,
    );
  });

  it('takes an index name of 64 characters with digits, "_" and "-"', async () => {
    const name = `a1_-${'b'.repeat(60)}`;
    const app = await inModule(variant('LongIndex', { index: name }));
    expect(app.container.make(SearchIndexes).get(name)).toBeDefined();
  });

  it.each([
    ['', '""'],
    [undefined, 'undefined'],
    [7, 'a number'],
  ])('refuses the key %j', async (key, shown) => {
    expect(await refusal(inModule(variant('BadKeyIndex', { key })))).toBe(
      `[marmeon:Q9] BadKeyIndex (module pages) has static key = ${shown}, but the key is the name of a column of its rows: static key = 'id'.`,
    );
  });

  it.each(['__proto__', 'constructor', 'toString'])('refuses the key %j, a name every object has', async (key) => {
    expect(await refusal(inModule(variant('ProtoKeyIndex', { key })))).toBe(
      `[marmeon:Q9] ProtoKeyIndex (module pages) has static key = "${key}", a name every object has, so a row without that column would still seem to have it.`,
    );
  });

  it.each([
    [undefined, 'undefined'],
    [['title'], 'an array'],
    ['title', '"title"'],
  ])('refuses fields that are no object: %j', async (fields, shown) => {
    expect(await refusal(inModule(variant('BadFieldsIndex', { fields })))).toBe(
      `[marmeon:Q9] BadFieldsIndex (module pages) has static fields = ${shown}, but fields are an object of field names and weights: static fields = { title: 'A', body: 'C' }.`,
    );
  });

  it('refuses no fields and more than 32, and takes 32', async () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, 'D']));
    expect(await refusal(inModule(variant('EmptyIndex', { fields: {} })))).toBe('[marmeon:Q9] EmptyIndex (module pages) declares 0 fields, but an index has 1 to 32.');
    expect(await refusal(inModule(variant('WideIndex', { fields: many(33) })))).toBe('[marmeon:Q9] WideIndex (module pages) declares 33 fields, but an index has 1 to 32.');
    await expect(inModule(variant('FullIndex', { fields: many(32) }))).resolves.toBeDefined();
  });

  it.each(['Title', 'body text', '_body', 'body-text', 'b'.repeat(65), 'constructor'])('refuses the field name %j', async (field) => {
    expect(await refusal(inModule(variant('BadFieldIndex', { fields: { [field]: 'A' } })))).toBe(
      `[marmeon:Q9] BadFieldIndex (module pages) declares the field ${JSON.stringify(field)}, but a field name is lowercase letters, digits and "_", starting with a letter, at most 64 characters, and not "constructor".`,
    );
  });

  it.each([
    ['E', '"E"'],
    ['a', '"a"'],
    [1, 'a number'],
    [null, 'null'],
  ])('refuses the weight %j', async (weight, shown) => {
    expect(await refusal(inModule(variant('BadWeightIndex', { fields: { title: weight } })))).toBe(
      `[marmeon:Q9] BadWeightIndex (module pages) gives the field "title" the weight ${shown}, but a weight is 'A', 'B', 'C' or 'D'.`,
    );
  });

  it('refuses filters that are no list', async () => {
    expect(await refusal(inModule(variant('BadFiltersIndex', { filters: 'kind' })))).toBe(
      `[marmeon:Q9] BadFiltersIndex (module pages) has static filters = "kind", but filters are a list of attribute names: static filters = ['kind'].`,
    );
  });

  it.each([
    ['Kind', '"Kind"'],
    ['kind-of', '"kind-of"'],
    ['constructor', '"constructor"'],
    [3, 'a number'],
  ])('refuses the filter name %j', async (filter, shown) => {
    expect(await refusal(inModule(variant('BadFilterIndex', { filters: ['kind', filter] })))).toBe(
      `[marmeon:Q9] BadFilterIndex (module pages) declares the filter ${shown}, but a filter name is lowercase letters, digits and "_", starting with a letter, at most 64 characters, and not "constructor".`,
    );
  });

  it('refuses a hole in the filters', async () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    expect(await refusal(inModule(variant('HoleIndex', { filters: ['kind', , 'audience'] })))).toBe(
      '[marmeon:Q9] HoleIndex (module pages) declares the filter undefined, but a filter name is lowercase letters, digits and "_", starting with a letter, at most 64 characters, and not "constructor".',
    );
  });

  it('refuses filters = null rather than reading it as no filters', async () => {
    expect(await refusal(inModule(variant('NullFiltersIndex', { filters: null })))).toBe(
      `[marmeon:Q9] NullFiltersIndex (module pages) has static filters = null, but filters are a list of attribute names: static filters = ['kind'].`,
    );
  });

  it('shows at most 80 characters of a value it refuses', async () => {
    const key = 'k'.repeat(81);
    const Index = variant('LongFieldIndex', { fields: { [key]: 'A' } });
    expect(await refusal(inModule(Index))).toBe(
      `[marmeon:Q9] LongFieldIndex (module pages) declares the field "${'k'.repeat(80)}"…, but a field name is lowercase letters, digits and "_", starting with a letter, at most 64 characters, and not "constructor".`,
    );
  });

  it('names an anonymous class and a provider without a name as such', async () => {
    const Anonymous = variant('', { index: 'Bad' });
    expect(await refusal(inModule(Anonymous))).toMatch(/^\[marmeon:Q9\] \(unnamed class\) \(module pages\) has static index = "Bad"/);
    const Nameless = provider('NamelessProvider', [variant('X', { index: 'Bad' })]);
    Object.defineProperty(Nameless, 'name', { value: '' });
    expect(await refusal(boot({ providers: [Nameless] }))).toMatch(/^\[marmeon:Q9\] X \(provider \(unnamed\)\) has static index = "Bad"/);
  });

  it('refuses a filter twice, the filter locale and more than 32 filters, and takes 32', async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`);
    expect(await refusal(inModule(variant('TwiceIndex', { filters: ['kind', 'kind'] })))).toBe('[marmeon:Q9] TwiceIndex (module pages) declares the filter "kind" twice.');
    expect(await refusal(inModule(variant('LocaleIndex', { filters: ['locale'] })))).toBe(
      '[marmeon:Q9] LocaleIndex (module pages) declares the filter "locale", but every search already narrows by locale: remove it from static filters.',
    );
    expect(await refusal(inModule(variant('ManyIndex', { filters: many(33) })))).toBe('[marmeon:Q9] ManyIndex (module pages) declares 33 filters, but an index has at most 32.');
    await expect(inModule(variant('EnoughIndex', { filters: many(32) }))).resolves.toBeDefined();
  });

  it.each([
    ['reports', '"reports"'],
    ['', '""'],
    [null, 'null'],
  ])('refuses the connection %j', async (connection, shown) => {
    expect(await refusal(inModule(variant('ElsewhereIndex', { connection })))).toBe(
      `[marmeon:Q9] ElsewhereIndex (module pages) has static connection = ${shown}, but an index reads its rows on the default connection only: remove static connection.`,
    );
  });

  it('refuses a class without the method source() or toDocument(), or with an includes that is no method', async () => {
    class NoSource {
      static index = 'nosource';
      static key = 'id';
      static fields = { title: 'A' };
      toDocument(): AnyDocument {
        return { fields: {} };
      }
    }
    class FieldToDocument {
      static index = 'fieldtodocument';
      static key = 'id';
      static fields = { title: 'A' };
      source(): never {
        throw new Error('not called');
      }
      toDocument = (): AnyDocument => ({ fields: {} });
    }
    const Included = variant('IncludedIndex', {});
    Object.defineProperty(Included.prototype, 'includes', { value: true });
    expect(await refusal(inModule(NoSource))).toBe('[marmeon:Q9] NoSource (module pages) has no method source(): an index class defines source() and toDocument() as methods.');
    expect(await refusal(inModule(FieldToDocument))).toBe(
      '[marmeon:Q9] FieldToDocument (module pages) has no method toDocument(): an index class defines source() and toDocument() as methods.',
    );
    expect(await refusal(inModule(Included))).toBe('[marmeon:Q9] IncludedIndex (module pages) has an includes that is no method: define includes(row) as a method, or leave it out.');
  });

  it('refuses a searchIndexes that is no list, of a module and of a provider', async () => {
    expect(await refusal(boot({ modules: [{ name: 'pages', searchIndexes: PageIndex as never }] }))).toBe(
      '[marmeon:Q9] module pages has searchIndexes = a function, but searchIndexes is a list of index classes: searchIndexes: [PageIndex].',
    );
    expect(await refusal(boot({ providers: [provider('CmsServiceProvider', { pages: PageIndex })] }))).toBe(
      '[marmeon:Q9] provider CmsServiceProvider has searchIndexes = an object, but searchIndexes is a list of index classes: searchIndexes: [PageIndex].',
    );
  });

  it('refuses an entry that is no class, a hole included', async () => {
    expect(await refusal(inModule(PageIndex, 'posts'))).toBe('[marmeon:Q9] module pages lists "posts" at searchIndexes[1], which is not an index class.');
    expect(await refusal(boot({ providers: [provider('CmsServiceProvider', [new PageIndex()])] }))).toBe(
      '[marmeon:Q9] provider CmsServiceProvider lists an object at searchIndexes[0], which is not an index class.',
    );
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    expect(await refusal(boot({ providers: [provider('HoleProvider', [PageIndex, , PostIndex])] }))).toBe(
      '[marmeon:Q9] provider HoleProvider lists undefined at searchIndexes[1], which is not an index class.',
    );
  });

  it('knows a class by its identity: two classes with one class name and different index names are two indexes', async () => {
    const first = variant('SameIndex', { index: 'first' });
    const second = variant('SameIndex', { index: 'second' });
    const app = await inModule(first, second);
    const indexes = app.container.make(SearchIndexes);
    expect(indexes.get('first')).toBe(first);
    expect(indexes.get('second')).toBe(second);
  });
});
