import { defineMigration, sql } from '@marmeon/database';

// An FTS5 index over a view, which emptying the test database leaves alone: the view keeps its row while the index is empty, and the
// integrity check after the emptying has to refuse that. SQLite only.
export default defineMigration({
  up: (schema) => {
    schema.raw({ sqlite: sql`create view stale_docs as select 1 as id, 'marmalade' as body` });
    schema.raw({ sqlite: sql`create virtual table stale_fts using fts5(body, content='stale_docs', content_rowid='id')` });
  },
  down: (schema) => {
    schema.raw({ sqlite: sql`drop table stale_fts` });
    schema.raw({ sqlite: sql`drop view stale_docs` });
  },
});
