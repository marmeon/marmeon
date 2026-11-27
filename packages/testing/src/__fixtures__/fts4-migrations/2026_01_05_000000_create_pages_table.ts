import { defineMigration, sql } from '@marmeon/database';

// An FTS4 table with external content: emptying the test database has no consistent way for it, so it must refuse loudly. SQLite only.
export default defineMigration({
  up: (schema) => {
    schema.create('pages', (table) => {
      table.id();
      table.text('body');
    });
    schema.raw({ sqlite: sql`create virtual table pages_fts using fts4(body, content='pages')` });
  },
  down: (schema) => {
    schema.raw({ sqlite: sql`drop table pages_fts` });
    schema.drop('pages');
  },
});
