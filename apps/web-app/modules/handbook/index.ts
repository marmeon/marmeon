import { defineModule } from '@marmeon/core';
import { ArticleIndex } from './ArticleIndex.ts';
import { FaqIndex } from './FaqIndex.ts';
import routes from './routes.ts';
import { HandbookSeeder } from './seeders/HandbookSeeder.ts';

/**
 * The handbook (`/handbook/search`): articles and questions in English and German, searched together. Only published entries are
 * in the indexes, and the audience filter decides what a guest or a member with a confirmed address finds.
 */
export default defineModule({
  name: 'handbook',
  migrations: new URL('./migrations/', import.meta.url),
  searchIndexes: [ArticleIndex, FaqIndex],
  seeders: [HandbookSeeder],
  routes,
});

