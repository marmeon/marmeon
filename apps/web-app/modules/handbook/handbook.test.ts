import { Connections, Database } from '@marmeon/database';
import type { PageProps } from '@marmeon/http';
import { Search } from '@marmeon/search';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory, type User } from '../auth/index.ts';
import { ArticleIndex } from './ArticleIndex.ts';
import type { SearchHandbookController } from './controllers/SearchHandbookController.ts';
import { HandbookRepository, type ArticleValues, type FaqValues } from './HandbookRepository.ts';

// The search of the handbook on the `database` driver: SQLite (FTS5) under `pnpm test`, Postgres under `pnpm test:pgsql`.

const postgres = process.env.DB_DRIVER === 'pgsql';

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
});

const handbook = () => app.make(HandbookRepository);
const published = () => new Date().toISOString();
const article = (values: Partial<ArticleValues> = {}): ArticleValues => ({
  locale: 'en',
  title: 'Moving house',
  summary: 'What to change in your account when you move.',
  body: 'Update your address before you move.',
  audience: 'public',
  published_at: published(),
  ...values,
});
const faq = (values: Partial<FaqValues> = {}): FaqValues => ({
  locale: 'en',
  question: 'How do I change my address?',
  answer: 'Open your profile and edit the address.',
  audience: 'public',
  published_at: published(),
  ...values,
});

type Page = PageProps<SearchHandbookController>;

/** The page `/handbook/search?q=…` shows, as a guest or as `as`, in the language of `locale`; it asserts the 200 first. */
async function search(q: string, { as, locale = 'en', page }: { as?: User; locale?: string; page?: number } = {}): Promise<Page> {
  let shown: Page | undefined;
  const query = new URLSearchParams({ q, ...(page === undefined ? {} : { page: String(page) }) });
  await (as ? app.actingAs(as) : app)
    .navigating()
    .get(`/handbook/search?${query}`, { headers: { 'accept-language': locale } })
    .assertOk()
    .assertPage<SearchHandbookController>('handbook/Search', (props) => {
      shown = props;
    });
  return shown!;
}

const titles = (page: Page) => page.entries.map((entry) => entry.title);

describe('the handbook search', { timeout: 30_000 }, () => {
  it('finds a published article and not a draft, and loses an article that is unpublished', async () => {
    const id = await handbook().saveArticle(article({ title: 'Moving house' }));
    await handbook().saveArticle(article({ title: 'Moving offices', published_at: null }));

    const found = await search('moving');
    expect(titles(found)).toEqual(['Moving house']);
    expect(found.meta?.total).toBe(1);
    expect(found.entries[0]!.excerpt.some((segment) => segment.match && segment.text.toLowerCase() === 'moving')).toBe(true);

    await handbook().saveArticle(article({ title: 'Moving house', published_at: null }), id);
    const after = await search('moving');
    expect(after.entries).toEqual([]);
    expect(after.meta?.total).toBe(0);
  });

  it('shows a guest the public questions only, and a member the members\' questions as well', async () => {
    await handbook().saveFaq(faq({ question: 'How are the rates set?', answer: 'The rates follow the season.' }));
    await handbook().saveFaq(faq({ question: 'Where are the member rates?', answer: 'Signed in, the rates show on every booking.', audience: 'members' }));

    const guest = await search('rates');
    expect(guest.unavailable).toBe(false);
    expect(titles(guest)).toEqual(['How are the rates set?']);
    // The filter is part of the search, so the total counts only what the guest may see.
    expect(guest.meta?.total).toBe(1);

    // An account that never confirmed its address is no member.
    const unconfirmed = await search('rates', { as: await app.factory(UserFactory).state('unverified').create() });
    expect(titles(unconfirmed)).toEqual(['How are the rates set?']);
    expect(unconfirmed.meta?.total).toBe(1);

    const member = await search('rates', { as: await app.factory(UserFactory).create() });
    expect(titles(member).sort()).toEqual(['How are the rates set?', 'Where are the member rates?']);
    expect(member.meta?.total).toBe(2);
  });

  it('leaves no hit when the transaction around a save rolls back', async () => {
    await expect(
      app.make(Connections).transaction(async () => {
        await handbook().saveArticle(article({ title: 'Rolled back' }));
        expect(titles(await search('rolled'))).toEqual(['Rolled back']);
        throw new Error('a later step failed');
      }),
    ).rejects.toThrow('a later step failed');

    expect((await search('rolled')).entries).toEqual([]);
    const result = await app.make(Search).query({ in: ArticleIndex, term: 'rolled' });
    expect(result.ok && result.value.meta.total).toBe(0);
  });

  it('writes no row when indexing it fails, for an article and a question', async () => {
    vi.spyOn(Search.prototype, 'index').mockRejectedValue(new Error('the index failed'));
    await expect(handbook().saveArticle(article())).rejects.toThrow('the index failed');
    await expect(handbook().saveFaq(faq())).rejects.toThrow('the index failed');
    await app.assertDatabaseCount('handbook_articles', 0);
    await app.assertDatabaseCount('handbook_faqs', 0);
  });

  it('answers a term full of syntax, and a page past the reachable hits, with the page', async () => {
    await handbook().saveArticle(article({ title: 'Foo and bar' }));
    expect(titles(await search('foo'))).toEqual(['Foo and bar']);
    // Quotes, `OR` and brackets are no syntax: the words are searched, so the result is a page — with or without the hit, never an error.
    const page = await search('foo" OR (bar');
    expect(page.unavailable).toBe(false);
    expect(page.q).toBe('foo" OR (bar');
    expect(page.meta).not.toBeNull();
    const past = await search('foo', { page: 101 });
    expect(past.meta?.page).toBe(1);
    expect(titles(past)).toEqual(['Foo and bar']);
  });

  it('pages through the hits, ten to a page', async () => {
    for (let i = 1; i <= 12; i++) await handbook().saveArticle(article({ title: `Guide ${i}`, summary: 'A guide.', body: 'A guide to the handbook.' }));
    const first = await search('guide');
    const second = await search('guide', { page: 2 });
    expect(first.entries).toHaveLength(10);
    expect(second.entries).toHaveLength(2);
    expect(second.meta).toMatchObject({ page: 2, total: 12, lastPage: 2 });
    expect(new Set([...titles(first), ...titles(second)]).size).toBe(12);
  });

  it('indexes the new text when an article or a question changes', async () => {
    const articleId = await handbook().saveArticle(article({ title: 'Moving house' }));
    const faqId = await handbook().saveFaq(faq({ question: 'Where is the kitchen?' }));
    await handbook().saveArticle(article({ title: 'Changing offices' }), articleId);
    await handbook().saveFaq(faq({ question: 'How do I pack boxes?' }), faqId);
    expect((await search('house')).entries).toEqual([]);
    expect((await search('kitchen')).entries).toEqual([]);
    expect(titles(await search('offices'))).toEqual(['Changing offices']);
    expect(titles(await search('boxes'))).toEqual(['How do I pack boxes?']);
    // An id without a row changes nothing and indexes nothing.
    expect(await handbook().saveArticle(article(), 999_999)).toBeUndefined();
  });

  it('leaves out a hit whose row was unpublished or moved to members behind the back of search', async () => {
    const articleId = await handbook().saveArticle(article({ title: 'Moving house' }));
    const faqId = await handbook().saveFaq(faq({ question: 'Moving boxes?' }));
    // Writes that skip the repository: the index still holds the public, published documents.
    await app.make(Database).updateTable('handbook_articles').set({ audience: 'members' }).where('id', '=', articleId!).execute();
    await app.make(Database).updateTable('handbook_faqs').set({ published_at: null }).where('id', '=', faqId!).execute();
    // And the other way round: each table drops a row by each of its two conditions.
    const otherArticleId = await handbook().saveArticle(article({ title: 'Moving van' }));
    const otherFaqId = await handbook().saveFaq(faq({ question: 'Moving day?' }));
    await app.make(Database).updateTable('handbook_articles').set({ published_at: null }).where('id', '=', otherArticleId!).execute();
    await app.make(Database).updateTable('handbook_faqs').set({ audience: 'members' }).where('id', '=', otherFaqId!).execute();
    const page = await search('moving');
    expect(page.meta?.total).toBe(4);
    expect(page.entries).toEqual([]);
  });

  it('says so when the search service is unavailable', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', search: 'fake' });
    await handbook().saveArticle(article({ title: 'Moving house' }));
    app.search.failNext('unavailable');
    const page = await search('moving');
    expect(page).toMatchObject({ unavailable: true, entries: [], meta: null });
  });

  it('finds articles and questions in one list, in the language of the request', async () => {
    await handbook().saveArticle(article({ title: 'Moving house', body: 'Update your address before you move.' }));
    await handbook().saveFaq(faq({ question: 'How do I change my address?' }));
    await handbook().saveArticle(article({ locale: 'de', title: 'Umzug', summary: 'Was du änderst.', body: 'Ändere deine address vor dem Umzug.' }));

    const english = await search('address');
    expect(english.entries.map((entry) => [entry.kind, entry.title]).sort()).toEqual([
      ['article', 'Moving house'],
      ['faq', 'How do I change my address?'],
    ]);
    expect(titles(await search('address', { locale: 'de' }))).toEqual(['Umzug']);
  });

  it.runIf(postgres)('finds „Häuser“ for „Haus“ in a German article (Postgres stems the words)', async () => {
    await handbook().saveArticle(article({ locale: 'de', title: 'Umzug', summary: 'Was du im Konto änderst.', body: 'Ändere deine Adresse, bevor die Häuser den Besitzer wechseln.' }));
    expect(titles(await search('Haus', { locale: 'de' }))).toEqual(['Umzug']);
  });
});

describe('the handbook search page as the browser gets it', { timeout: 30_000 }, () => {
  let server: SsrServer;
  beforeAll(async () => {
    server = await startSsrServer(application);
  }, 30_000);
  afterAll(() => server?.close());

  it('renders an excerpt as text, its matches in <mark>', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', ssr: true, ssrServer: server });
    await handbook().saveArticle(article({ title: 'Moving <script>alert(1)</script>', summary: 'Plain.', body: 'A tag for moving.' }));
    const html = (await app.get('/handbook/search?q=moving', { headers: { accept: 'text/html', 'accept-language': 'en' } }).assertOk()).body;
    expect(html).toMatch(/<mark>moving<\/mark>/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
