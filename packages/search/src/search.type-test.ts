// Type guarantees of Search — checked by `tsc` (pnpm build / typecheck), never run.
import type { Connection, Database } from '@marmeon/database';
import { describe, it } from 'vitest';
import type { Search, SearchHit } from './search.ts';
import { SearchIndex, type SearchDocument } from './search-index.ts';

interface PageRow {
  id: number;
  title: string;
  kind: string;
  tenant: number;
}

interface PostRow {
  slug: string;
  title: string;
  kind: string;
}

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'highest' } as const;
  static readonly filters = ['kind', 'tenant'] as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').selectAll();
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return { fields: { title: row.title }, filters: { kind: row.kind, tenant: row.tenant } };
  }
}

class PostIndex extends SearchIndex<PostRow> {
  static readonly index = 'posts';
  static readonly key = 'slug';
  static readonly fields = { title: 'highest' } as const;
  static readonly filters = ['kind'] as const;

  source(db: Database) {
    return (db as unknown as Connection<{ posts: PostRow }>).selectFrom('posts').selectAll();
  }

  toDocument(row: PostRow): SearchDocument<typeof PostIndex> {
    return { fields: { title: row.title }, filters: { kind: row.kind } };
  }
}

declare const search: Search;
declare const page: PageRow;

describe('Search', () => {
  it('takes rows or keys of the index, never both in one list', () => {
    void search.index(PageIndex, page);
    void search.index(PageIndex, [page]);
    void search.index(PageIndex, 1);
    void search.index(PageIndex, [1, 2]);
    void search.index(PostIndex, 'a-slug');
    // @ts-expect-error — a list holds only rows or only keys.
    void search.index(PageIndex, [page, 1]);
    // @ts-expect-error — the key of PageIndex is a number.
    void search.index(PageIndex, 'one');
    // @ts-expect-error — remove() takes keys, not rows.
    void search.remove(PageIndex, page);
    void search.remove(PostIndex, ['a', 'b']);
  });

  it('takes only the filters every index of the search declares', async () => {
    await search.query({ in: PageIndex, term: 'x', filters: { kind: 'page', tenant: [1, 2] } });
    await search.query({ in: [PageIndex, PostIndex], term: 'x', filters: { kind: ['page', 'post'] } });
    // @ts-expect-error — PostIndex does not declare tenant.
    await search.query({ in: [PageIndex, PostIndex], term: 'x', filters: { tenant: 1 } });
    // @ts-expect-error — no index declares author.
    await search.query({ in: PageIndex, term: 'x', filters: { author: 'a' } });
    // @ts-expect-error — a list of values is never empty.
    await search.query({ in: PageIndex, term: 'x', filters: { kind: [] } });
    // @ts-expect-error — a filter value is never null (undefined is refused at run time only: an optional property takes it).
    await search.query({ in: PageIndex, term: 'x', filters: { kind: null } });
    const list = [PageIndex, PostIndex];
    await search.query({ in: list, term: 'x', filters: { kind: 'page' } });
  });

  it('returns hits as a union by index, each with the key type of its index', async () => {
    const result = await search.query({ in: [PageIndex, PostIndex], term: 'x' });
    if (!result.ok) {
      const kind: 'unavailable' | 'missing-index' = result.error.kind;
      void kind;
      return;
    }
    for (const hit of result.value.data) {
      if (hit.index === 'pages') {
        const id: number = hit.key;
        void id;
      } else {
        const slug: string = hit.key;
        // @ts-expect-error — the key of a post is a string.
        const wrong: number = hit.key;
        void [slug, wrong];
      }
    }
    const hit: SearchHit<typeof PageIndex> = { index: 'pages', key: 1, score: 1, excerpt: [{ text: 'a', match: true }] };
    // @ts-expect-error — the index name of a page hit is 'pages'.
    const other: SearchHit<typeof PageIndex> = { index: 'posts', key: 1, score: 1 };
    void [hit, other];
  });
});
