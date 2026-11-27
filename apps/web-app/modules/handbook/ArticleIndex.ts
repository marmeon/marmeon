import type { Database, Row } from '@marmeon/database';
import { SearchIndex, type SearchDocument } from '@marmeon/search';

type ArticleRow = Pick<Row<'handbook_articles'>, 'id' | 'locale' | 'title' | 'summary' | 'body' | 'audience' | 'published_at'>;

/** The published handbook articles, searched by title, summary and body in their own language, filtered by audience. */
export class ArticleIndex extends SearchIndex<ArticleRow> {
  static readonly index = 'handbook-articles';
  static readonly key = 'id';
  static readonly fields = { title: 'A', summary: 'B', body: 'C' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return db.selectFrom('handbook_articles').select(['id', 'locale', 'title', 'summary', 'body', 'audience', 'published_at']);
  }

  override includes(row: ArticleRow): boolean {
    return row.published_at !== null;
  }

  toDocument(row: ArticleRow): SearchDocument<typeof ArticleIndex> {
    return {
      locale: row.locale,
      fields: { title: row.title, summary: row.summary, body: row.body },
      filters: { audience: row.audience },
    };
  }
}
