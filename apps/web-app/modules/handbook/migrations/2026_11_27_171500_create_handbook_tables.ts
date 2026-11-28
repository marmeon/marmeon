import { defineMigration } from '@marmeon/database';

// Two content types in several languages: one row per article or question and language. A row without `published_at` is a draft,
// and `audience` says who may read it — both decide what the search finds (ArticleIndex, FaqIndex).
export default defineMigration({
  up: (schema) => {
    schema.create('handbook_articles', (table) => {
      table.id();
      table.string('locale', 35);
      table.string('title', 200);
      table.text('summary');
      table.text('body');
      table.string('audience', 16).oneOf('public', 'members');
      table.timestamp('published_at').nullable();
      table.timestamps();
    });
    schema.create('handbook_faqs', (table) => {
      table.id();
      table.string('locale', 35);
      table.string('question', 300);
      table.text('answer');
      table.string('audience', 16).oneOf('public', 'members');
      table.timestamp('published_at').nullable();
      table.timestamps();
    });
  },
  down: (schema) => {
    schema.drop('handbook_faqs');
    schema.drop('handbook_articles');
  },
});
