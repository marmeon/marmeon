// Type guarantees of index classes and their registration — checked by `tsc` (pnpm build / typecheck), never run.
import { defineModule, type ServiceProviderClass } from '@marmeon/core';
import type { Connection, Database } from '@marmeon/database';
import { describe, it } from 'vitest';
import './provider.ts';
import { SearchIndex, type AnyDocument, type FiltersOf, type KeyOf, type SearchDocument } from './search-index.ts';

interface PageRow {
  id: number;
  title: string;
  summary: string | null;
  kind: string;
  published: boolean;
}

const pages = (db: Database) => (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').selectAll();

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A', summary: 'B' } as const;
  static readonly filters = ['kind', 'audience'] as const;

  source(db: Database) {
    return pages(db);
  }

  override includes(row: PageRow): boolean {
    return row.published;
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return { locale: null, fields: { title: row.title, summary: row.summary }, filters: { kind: row.kind } };
  }
}

class NewsIndex extends SearchIndex<PageRow> {
  static readonly index = 'news';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;
  static readonly filters = ['kind'] as const;

  source(db: Database) {
    return pages(db);
  }

  toDocument(row: PageRow): SearchDocument<typeof NewsIndex> {
    return { fields: { title: row.title } };
  }
}

describe('SearchIndex', () => {
  it('refuses an undeclared field or filter in toDocument', () => {
    class Wrong extends SearchIndex<PageRow> {
      static readonly index = 'wrong';
      static readonly key = 'id';
      static readonly fields = { title: 'A' } as const;
      static readonly filters = ['kind'] as const;

      source(db: Database) {
        return pages(db);
      }

      toDocument(row: PageRow): SearchDocument<typeof Wrong> {
        return {
          fields: {
            title: row.title,
            // @ts-expect-error — `body` is no declared field.
            body: row.title,
          },
          filters: {
            kind: row.kind,
            // @ts-expect-error — `tenant` is no declared filter.
            tenant: 1,
          },
        };
      }
    }
    void Wrong;
  });

  it('refuses any filter on an index that declares none, and on indexes that share none', () => {
    class Plain extends SearchIndex<PageRow> {
      static readonly index = 'plain';
      static readonly key = 'id';
      static readonly fields = { title: 'A' } as const;

      source(db: Database) {
        return pages(db);
      }

      toDocument(row: PageRow): SearchDocument<typeof Plain> {
        return { fields: { title: row.title }, filters: {} };
      }
    }
    // @ts-expect-error — Plain declares no filter.
    const document: SearchDocument<typeof Plain> = { fields: {}, filters: { tenant: 1 } };
    const none: FiltersOf<typeof Plain> = {};
    // @ts-expect-error — Plain declares no filter.
    const tenant: FiltersOf<typeof Plain> = { tenant: 1 };
    // @ts-expect-error — PageIndex and Plain share no filter.
    const disjoint: FiltersOf<typeof PageIndex | typeof Plain> = { audience: 'staff' };
    void [document, none, tenant, disjoint];
  });

  it('refuses every filter of a list written without as const, instead of taking any name', () => {
    class Loose extends SearchIndex<PageRow> {
      static readonly index = 'loose';
      static readonly key = 'id';
      static readonly fields = { title: 'A' } as const;
      static readonly filters = ['kind'];

      source(db: Database) {
        return pages(db);
      }

      toDocument(row: PageRow): SearchDocument<typeof Loose> {
        return { fields: { title: row.title } };
      }
    }
    // @ts-expect-error — without `as const` no filter name is known.
    const document: SearchDocument<typeof Loose> = { fields: {}, filters: { tenant: 1 } };
    // @ts-expect-error — without `as const` no filter name is known.
    const filters: FiltersOf<typeof Loose> = { tenant: 1 };
    class Optional extends SearchIndex<PageRow> {
      static readonly index = 'optional';
      static readonly key = 'id';
      static readonly fields = { title: 'A' } as const;
      static readonly filters: readonly string[] | undefined = ['kind'];

      source(db: Database) {
        return pages(db);
      }

      toDocument(row: PageRow): SearchDocument<typeof Optional> {
        return { fields: { title: row.title } };
      }
    }
    // @ts-expect-error — a list typed `string[] | undefined` names no filter either.
    const optional: FiltersOf<typeof Optional> = { tenant: 1 };
    class OptionalStatic extends SearchIndex<PageRow> {
      static readonly index = 'optional_static';
      static readonly key = 'id';
      static readonly fields = { title: 'A' } as const;
      static readonly filters?: readonly string[] = ['kind'];

      source(db: Database) {
        return pages(db);
      }

      toDocument(row: PageRow): SearchDocument<typeof OptionalStatic> {
        return { fields: { title: row.title } };
      }
    }
    // @ts-expect-error — an optional static list names no filter either.
    const optionalStatic: FiltersOf<typeof OptionalStatic> = { tenant: 1 };
    void [document, filters, optional, optionalStatic];
  });

  it('refuses a connection other than default', () => {
    class Elsewhere extends NewsIndex {
      static readonly connection = 'reports';
    }
    // @ts-expect-error — an index reads its rows on the default connection.
    defineModule({ name: 'pages', searchIndexes: [Elsewhere] });
  });

  it('refuses a filter value that is no string, number or boolean', () => {
    const document: SearchDocument<typeof PageIndex> = {
      fields: {},
      // @ts-expect-error — a filter value is one string, number or boolean.
      filters: { kind: ['a', 'b'] },
    };
    void document;
  });

  it('refuses a weight other than A to D where the class is registered, in a module and on a provider', () => {
    class Heavy extends SearchIndex<PageRow> {
      static readonly index = 'heavy';
      static readonly key = 'id';
      static readonly fields = { title: 'E' } as const;

      source(db: Database) {
        return pages(db);
      }

      toDocument(row: PageRow): AnyDocument {
        return { fields: { title: row.title } };
      }
    }
    defineModule({ name: 'pages', searchIndexes: [PageIndex, NewsIndex] });
    // @ts-expect-error — a weight is 'A', 'B', 'C' or 'D'.
    defineModule({ name: 'pages', searchIndexes: [Heavy] });
    const fine: ServiceProviderClass = class {
      static searchIndexes = [PageIndex];
      boot(): void {}
    };
    // @ts-expect-error — a weight is 'A', 'B', 'C' or 'D'.
    const heavy: ServiceProviderClass = class {
      static searchIndexes = [Heavy];
      boot(): void {}
    };
    void [fine, heavy];
  });

  it('refuses a class without source() or toDocument() in a registration', () => {
    class NoMethods {
      static readonly index = 'none';
      static readonly key = 'id';
      static readonly fields = { title: 'A' } as const;
    }
    // @ts-expect-error — an index class has source() and toDocument().
    defineModule({ name: 'pages', searchIndexes: [NoMethods] });
  });

  it('types the key from the rows and the filters a search takes from every index it names', () => {
    const key: KeyOf<typeof PageIndex> = 42;
    // @ts-expect-error — the key column `id` is a number.
    const text: KeyOf<typeof PageIndex> = 'a-slug';
    const both: FiltersOf<typeof PageIndex | typeof NewsIndex> = { kind: ['page', 'news'] };
    // @ts-expect-error — `audience` is declared by PageIndex only.
    const onlyOne: FiltersOf<typeof PageIndex | typeof NewsIndex> = { audience: 'staff' };
    // @ts-expect-error — "any of" takes a non-empty list.
    const empty: FiltersOf<typeof PageIndex> = { kind: [] };
    void [key, text, both, onlyOne, empty];
  });
});
