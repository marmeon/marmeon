import type { Database, Row } from '@marmeon/database';
import { SearchIndex, type SearchDocument } from '@marmeon/search';

type FaqRow = Pick<Row<'handbook_faqs'>, 'id' | 'locale' | 'question' | 'answer' | 'audience' | 'published_at'>;

/** The published questions of the handbook, searched by question and answer in their own language, filtered by audience. */
export class FaqIndex extends SearchIndex<FaqRow> {
  static readonly index = 'handbook-faqs';
  static readonly key = 'id';
  static readonly fields = { question: 'A', answer: 'C' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return db.selectFrom('handbook_faqs').select(['id', 'locale', 'question', 'answer', 'audience', 'published_at']);
  }

  override includes(row: FaqRow): boolean {
    return row.published_at !== null;
  }

  toDocument(row: FaqRow): SearchDocument<typeof FaqIndex> {
    return {
      locale: row.locale,
      fields: { question: row.question, answer: row.answer },
      filters: { audience: row.audience },
    };
  }
}
