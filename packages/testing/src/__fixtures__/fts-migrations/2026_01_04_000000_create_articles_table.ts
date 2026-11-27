import { defineMigration, sql } from '@marmeon/database';

// One FTS5 table per kind of content: external (`articles_fts`, kept by triggers on `articles`), its own (`notes_fts`), none
// (`tags_fts`), none with its unindexed column kept (`Quoted fts`, its module name quoted as SQLite allows), and external again with
// the index sorting before its content table (`a_fts` over `z_docs`). SQLite only: FTS5 has no counterpart on Postgres.
export default defineMigration({
  up: (schema) => {
    schema.create('articles', (table) => {
      table.id();
      table.text('body');
    });
    schema.raw({ sqlite: sql`create virtual table articles_fts using fts5(body, content='articles', content_rowid='id')` });
    schema.raw({ sqlite: sql`create trigger articles_ai after insert on articles begin insert into articles_fts(rowid, body) values (new.id, new.body); end` });
    schema.raw({ sqlite: sql`create trigger articles_ad after delete on articles begin insert into articles_fts(articles_fts, rowid, body) values ('delete', old.id, old.body); end` });
    schema.raw({
      sqlite: sql`create trigger articles_au after update on articles begin insert into articles_fts(articles_fts, rowid, body) values ('delete', old.id, old.body); insert into articles_fts(rowid, body) values (new.id, new.body); end`,
    });
    schema.raw({ sqlite: sql`create virtual table notes_fts using fts5(body)` });
    schema.raw({ sqlite: sql`create virtual table tags_fts using fts5(body, content='')` });
    schema.raw({ sqlite: sql`create virtual table "Quoted fts" using "fts5"(body, extra unindexed, content='', contentless_unindexed=1)` });
    schema.raw({ sqlite: sql`create virtual table a_fts using fts5(body, content='z_docs', content_rowid='id')` });
    schema.create('z_docs', (table) => {
      table.id();
      table.text('body');
    });
  },
  down: (schema) => {
    schema.drop('z_docs');
    schema.raw({ sqlite: sql`drop table a_fts` });
    schema.raw({ sqlite: sql`drop table "Quoted fts"` });
    schema.raw({ sqlite: sql`drop table tags_fts` });
    schema.raw({ sqlite: sql`drop table notes_fts` });
    schema.raw({ sqlite: sql`drop table articles_fts` });
    schema.drop('articles');
  },
});
