import { Connections, type SeedContext } from '@marmeon/database';
import { Search } from '@marmeon/search';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ArticleIndex } from './ArticleIndex.ts';
import { FaqIndex } from './FaqIndex.ts';
import { HandbookSeeder } from './seeders/HandbookSeeder.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

describe('HandbookSeeder', { timeout: 30_000 }, () => {
  it('saves the entries with their search documents: published ones only, each in its language and audience', async () => {
    const lines: string[] = [];
    const context: SeedContext = {
      factory: (definition) => app.factory(definition),
      db: app.make(Connections).get(),
      output: { line: () => {}, info: (text: string) => void lines.push(text), warn: () => {}, table: () => {} },
    };
    await app.make(HandbookSeeder).handle(context);
    expect(lines).toEqual(['Made 4 handbook articles and 3 questions.']);
    await app.assertDatabaseCount('handbook_articles', 4);
    await app.assertDatabaseCount('handbook_faqs', 3);

    const search = app.make(Search);
    const total = async (term: string, locale: string, audience: 'public' | readonly ['public', 'members']) => {
      const result = await search.query({ in: [ArticleIndex, FaqIndex], term, locale, filters: { audience } });
      if (!result.ok) throw new Error(result.error.message);
      return result.value.meta.total;
    };
    expect(await total('address', 'en', 'public')).toBe(2);
    expect(await total('adresse', 'de', 'public')).toBe(2);
    expect(await total('rates', 'en', 'public')).toBe(0);
    expect(await total('rates', 'en', ['public', 'members'])).toBe(2);
    expect(await total('draft', 'en', ['public', 'members'])).toBe(0);
  });
});
