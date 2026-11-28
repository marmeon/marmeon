// Type guarantees of the search fake's assertions — checked by `tsc` (pnpm build / typecheck), never run.
import { describe, expectTypeOf, it } from 'vitest';
import type { StoredDocument } from './driver.ts';
import type { RecordedSearchWrite, SearchFake } from './fake.ts';
import { SearchIndex, type SearchDocument } from './search-index.ts';

interface PageRow {
  id: number;
  title: string;
}

interface NoteRow {
  slug: string;
  title: string;
}

declare class PageIndex extends SearchIndex<PageRow> {
  static readonly index: 'pages';
  static readonly key: 'id';
  static readonly fields: { readonly title: 'highest' };
  source(): never;
  toDocument(row: PageRow): SearchDocument<typeof PageIndex>;
}

declare class NoteIndex extends SearchIndex<NoteRow> {
  static readonly index: 'notes';
  static readonly key: 'slug';
  static readonly fields: { readonly title: 'highest' };
  source(): never;
  toDocument(row: NoteRow): SearchDocument<typeof NoteIndex>;
}

describe('search fake types', () => {
  it('takes a key with the type of the key column, or a function of the stored document', () => {
    const search = {} as SearchFake;
    search.assertIndexed(PageIndex, 1).assertRemoved(NoteIndex, 'n-1');
    // @ts-expect-error — the key column of PageIndex holds numbers.
    search.assertIndexed(PageIndex, '1');
    // @ts-expect-error — the key column of NoteIndex holds strings.
    search.assertRemoved(NoteIndex, 1);
    // @ts-expect-error — an assertion takes an index class first.
    search.assertIndexed({}, 1);
    search.assertIndexed(PageIndex, (document) => {
      expectTypeOf(document).toEqualTypeOf<StoredDocument>();
      return true;
    });
    // @ts-expect-error — the function answers with a boolean.
    search.assertIndexed(PageIndex, () => 'yes');
    expectTypeOf(search.written).toEqualTypeOf<readonly RecordedSearchWrite[]>();
  });

  it('fails a search only with a kind a search failure has', () => {
    const search = {} as SearchFake;
    search.failNext('missing-index', 2);
    // @ts-expect-error — no failure of this kind exists.
    search.failNext('down');
  });
});
