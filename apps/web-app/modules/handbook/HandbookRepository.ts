import { Clock } from '@marmeon/core';
import { Connections, Database, type NewRow } from '@marmeon/database';
import { Search, type ExcerptSegment, type SearchHit } from '@marmeon/search';
import { ArticleIndex } from './ArticleIndex.ts';
import { FaqIndex } from './FaqIndex.ts';

export type Audience = 'public' | 'members';
export type ArticleValues = Omit<NewRow<'handbook_articles'>, 'id' | 'created_at' | 'updated_at'>;
export type FaqValues = Omit<NewRow<'handbook_faqs'>, 'id' | 'created_at' | 'updated_at'>;

/** One hit of the handbook search, in the order of relevance: what the page shows of it. */
export interface HandbookEntry {
  readonly kind: 'article' | 'faq';
  readonly id: number;
  readonly title: string;
  readonly excerpt: readonly ExcerptSegment[];
}

/**
 * Writes the articles and questions of the handbook together with their search documents, and loads the entries of a search.
 * A save and its `search.index()` run in one transaction: a rollback leaves neither the row nor its document.
 */
export class HandbookRepository {
  readonly #connections: Connections;
  readonly #db: Database<'handbook'>;
  readonly #search: Search;
  readonly #clock: Clock;

  constructor(connections: Connections, db: Database<'handbook'>, search: Search, clock: Clock) {
    this.#connections = connections;
    this.#db = db;
    this.#search = search;
    this.#clock = clock;
  }

  /**
   * Creates an article, or changes the one with `id`; `published_at: null` makes it a draft, which search no longer finds. Resolves to the id, or
   * `undefined` when no row has `id`.
   */
  saveArticle(values: ArticleValues, id?: number): Promise<number | undefined> {
    return this.#connections.transaction(async () => {
      const saved =
        id === undefined
          ? await this.#db.insertInto('handbook_articles').values(values).returning('id').executeTakeFirstOrThrow()
          : await this.#db.updateTable('handbook_articles').set({ ...values, updated_at: this.#now() }).where('id', '=', id).returning('id').executeTakeFirst();
      // `index()` reads the row again through ArticleIndex.source() and removes it from the index when includes() refuses it.
      if (saved) await this.#search.index(ArticleIndex, saved.id);
      return saved?.id;
    });
  }

  /**
   * Creates a question, or changes the one with `id`; `published_at: null` makes it a draft, which search no longer finds. Resolves to the id, or
   * `undefined` when no row has `id`.
   */
  saveFaq(values: FaqValues, id?: number): Promise<number | undefined> {
    return this.#connections.transaction(async () => {
      const saved =
        id === undefined
          ? await this.#db.insertInto('handbook_faqs').values(values).returning('id').executeTakeFirstOrThrow()
          : await this.#db.updateTable('handbook_faqs').set({ ...values, updated_at: this.#now() }).where('id', '=', id).returning('id').executeTakeFirst();
      if (saved) await this.#search.index(FaqIndex, saved.id);
      return saved?.id;
    });
  }

  /**
   * The entries of a page of hits, in the order of the hits. A hit carries only its key, so the rows are loaded here — again with
   * the publication of the indexes and the audience of the search's filter, so a row unpublished or moved to another audience
   * since it was indexed is left out (on a driver that writes through the queue, until its sync job runs).
   */
  async entriesFor(hits: readonly SearchHit<typeof ArticleIndex | typeof FaqIndex>[], audiences: readonly Audience[]): Promise<HandbookEntry[]> {
    const articleIds = hits.flatMap((hit) => (hit.index === ArticleIndex.index ? [hit.key] : []));
    const faqIds = hits.flatMap((hit) => (hit.index === FaqIndex.index ? [hit.key] : []));
    const articles = articleIds.length
      ? await this.#db.selectFrom('handbook_articles').select(['id', 'title']).where('id', 'in', articleIds).where('published_at', 'is not', null).where('audience', 'in', audiences).execute()
      : [];
    const faqs = faqIds.length
      ? await this.#db.selectFrom('handbook_faqs').select(['id', 'question']).where('id', 'in', faqIds).where('published_at', 'is not', null).where('audience', 'in', audiences).execute()
      : [];
    const articleTitles = new Map(articles.map((row) => [row.id, row.title]));
    const faqTitles = new Map(faqs.map((row) => [row.id, row.question]));
    return hits.flatMap((hit): HandbookEntry[] => {
      const kind = hit.index === ArticleIndex.index ? 'article' : 'faq';
      const title = kind === 'article' ? articleTitles.get(hit.key) : faqTitles.get(hit.key);
      return title === undefined ? [] : [{ kind, id: hit.key, title, excerpt: hit.excerpt ?? [] }];
    });
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }
}
