import { defineMigration, sql } from '@marmeon/database';
import { uploadsTableConnection } from '@marmeon/storage';

// For a `temporary_uploads` table created before the limits on open uploads: the two indexes their counts use. Idempotent.
export default defineMigration({
  connection: uploadsTableConnection,
  up: (schema) => {
    schema.raw(sql`create index if not exists temporary_uploads_expires_at_index on temporary_uploads (expires_at)`);
    schema.raw(sql`create index if not exists temporary_uploads_session_expires_at_index on temporary_uploads (session, expires_at)`);
  },
  down: (schema) => {
    schema.raw(sql`drop index if exists temporary_uploads_session_expires_at_index`);
    schema.raw(sql`drop index if exists temporary_uploads_expires_at_index`);
  },
});
