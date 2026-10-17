import { defineMigration } from '../../../index.ts';

// SQLite changes no column in place: loaded on Postgres only. The column is named by its name after the rename, and changed before the drop.
export default defineMigration({
  up: (schema) =>
    schema.alter('slugs', (table) => {
      table.renameColumn('slug', 'handle');
      table.notNull('handle');
      table.nullable('note');
      table.notNull('scrap');
      table.dropColumn('scrap');
    }),
});
