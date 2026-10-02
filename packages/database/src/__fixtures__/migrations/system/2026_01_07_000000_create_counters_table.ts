import { defineMigration } from '../../../index.ts';

// On the connection the app's configuration names (like the cache's tables follow CACHE_CONNECTION, E108).
export default defineMigration({
  connection: (container) => container.make<string>('counter connection' as never),
  up: (schema) =>
    schema.create('counters', (table) => {
      table.string('key').primary();
      table.integer('n');
      table.text('owner_token').secret();
    }),
  down: (schema) => schema.drop('counters'),
});
