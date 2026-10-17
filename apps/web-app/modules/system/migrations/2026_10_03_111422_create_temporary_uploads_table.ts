// @marmeon-stub storage 1
import { defineMigration } from '@marmeon/database';
import { uploadsTableConnection } from '@marmeon/storage';

// The table of temporary uploads (written by `marmeon make:uploads-table`): a row per file uploaded ahead of its form — the
// session it belongs to (a hash, never the id), the route and field it is for, where it waits (disk and key), the name the
// browser sent (for showing only), the field's limit, the size the browser announced (the bytes are cut off there, and the open
// uploads are counted by it), and times in epoch milliseconds: made, expires, sending started, complete, used.
// `marmeon uploads:prune` deletes expired rows and rows older than a day, then their files. It lives on the uploads' connection
// (UPLOADS_CONNECTION) — infrastructure like the cache and sessions: with SQLite best a file of its own, so a token can be
// used inside a transaction and a rollback never makes it usable again. The indexes serve the counts of open uploads.
export default defineMigration({
  connection: uploadsTableConnection,
  up: (schema) => {
    schema.create('temporary_uploads', (table) => {
      table.string('id', 36).primary();
      table.string('session', 64);
      table.string('route', 200);
      table.string('field', 200);
      table.string('disk', 100);
      table.string('key', 255);
      table.string('name', 255);
      table.bigInteger('max_bytes');
      table.bigInteger('size').nullable();
      table.bigInteger('created_at');
      table.bigInteger('expires_at');
      table.bigInteger('started_at').nullable();
      table.bigInteger('uploaded_at').nullable();
      table.bigInteger('consumed_at').nullable();
      table.index('created_at');
      table.index('expires_at');
      table.index(['session', 'expires_at']);
    });
  },
  down: (schema) => {
    schema.drop('temporary_uploads');
  },
});
