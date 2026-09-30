import { defineMigration } from '@bespokecore/database';

export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
      table.string('title');
      table.boolean('pinned').default(false);
    }),
  down: (schema) => schema.drop('notes'),
});
