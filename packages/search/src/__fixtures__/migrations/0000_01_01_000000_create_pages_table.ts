import { defineMigration } from '@marmeon/database';

// The rows the indexes of the tests read: pages with a slug key next to the numeric id, an audience, a tenant and a locale.
export default defineMigration({
  up: (schema) =>
    schema.create('pages', (table) => {
      table.id();
      table.string('slug', 253).unique();
      table.text('title');
      table.text('summary').nullable();
      table.text('body').nullable();
      table.string('audience', 32);
      table.integer('tenant').nullable();
      table.boolean('featured').default(false);
      table.string('locale', 35).nullable();
      table.boolean('published').default(true);
    }),
  down: (schema) => schema.drop('pages'),
});
