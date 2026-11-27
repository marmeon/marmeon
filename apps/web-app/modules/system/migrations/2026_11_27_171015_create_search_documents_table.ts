import { defineMigration, sql } from '@marmeon/database';

// The tables of SEARCH_DRIVER=database. search_documents holds one row per document: the key as JSON (42 or "a-slug"), the
// canonical locale, the filters as JSON and the text of the fields in a to d by weight (A to D). The texts are secret columns, so
// db:query and selectAll() never show indexed text. What the blueprint cannot write follows as raw SQL: on SQLite an FTS5 table
// over the four texts, kept current by triggers (an external-content table must be told the old values of every row it loses);
// on Postgres a `vector` column (the tsvector of the texts) with a GIN index, and a GIN index on the filters. search_rebuilds holds
// the state of a running rebuild of an index.
export default defineMigration({
  up: (schema) => {
    schema.create('search_documents', (table) => {
      table.id();
      table.string('index_name', 64);
      // The key as JSON: 253 UTF-16 units that JSON escapes as \u0001 take 253 * 6 + 2 = 1520 characters of ASCII, and unescaped
      // units take at most 3 bytes each, so an entry of the unique index stays below the btree limit of Postgres (about 2700 bytes).
      table.string('key', 1520);
      table.string('locale', 35).nullable();
      table.string('config', 63).nullable();
      table.json('filters').default({});
      table.text('a').secret().default('');
      table.text('b').secret().default('');
      table.text('c').secret().default('');
      table.text('d').secret().default('');
      table.bigInteger('revision').default(1);
      table.unique(['index_name', 'key']);
      table.index(['index_name', 'locale']);
    });
    schema.create('search_rebuilds', (table) => {
      table.string('index_name', 64).primary();
      table.uuid('run');
      table.string('phase', 16).oneOf('copy', 'sweep');
      table.text('after').nullable();
      table.string('target', 128).nullable();
      table.string('holder', 64).nullable();
      table.bigInteger('held_until').nullable();
      table.timestamp('started_at');
      // A hash of the index definition and the language map the run started with: a resume under another one starts over.
      table.string('fingerprint', 64).nullable();
    });
    schema.raw({
      sqlite: sql`create virtual table search_documents_fts using fts5(a, b, c, d, content='search_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3 4')`,
      mysql: null,
    });
    schema.raw({
      sqlite: sql`create trigger search_documents_ai after insert on search_documents begin
  insert into search_documents_fts (rowid, a, b, c, d) values (new.id, new.a, new.b, new.c, new.d);
end`,
      mysql: null,
    });
    schema.raw({
      sqlite: sql`create trigger search_documents_ad after delete on search_documents begin
  insert into search_documents_fts (search_documents_fts, rowid, a, b, c, d) values ('delete', old.id, old.a, old.b, old.c, old.d);
end`,
      mysql: null,
    });
    schema.raw({
      sqlite: sql`create trigger search_documents_au after update on search_documents begin
  insert into search_documents_fts (search_documents_fts, rowid, a, b, c, d) values ('delete', old.id, old.a, old.b, old.c, old.d);
  insert into search_documents_fts (rowid, a, b, c, d) values (new.id, new.a, new.b, new.c, new.d);
end`,
      mysql: null,
    });
    schema.raw({ pgsql: sql`alter table search_documents add column vector tsvector not null default ''::tsvector`, mysql: null });
    schema.raw({ pgsql: sql`create index search_documents_vector_index on search_documents using gin (vector)`, mysql: null });
    schema.raw({ pgsql: sql`create index search_documents_filters_index on search_documents using gin (filters jsonb_path_ops)`, mysql: null });
  },
  down: (schema) => {
    schema.raw({ sqlite: sql`drop table search_documents_fts`, mysql: null });
    schema.drop('search_rebuilds');
    schema.drop('search_documents');
  },
});
