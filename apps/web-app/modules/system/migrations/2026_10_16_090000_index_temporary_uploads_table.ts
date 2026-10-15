import { defineMigration, sql } from '@marmeon/database';
import { uploadsTableConnection } from '@marmeon/storage';

// For a `temporary_uploads` table created before the limits on open uploads: the two indexes their counts use. Idempotent.
export default defineMigration({
  connection: uploadsTableConnection,
  up: async (schema) => {
    await sql`create index if not exists temporary_uploads_expires_at_index on temporary_uploads (expires_at)`.execute(schema.db);
    await sql`create index if not exists temporary_uploads_session_expires_at_index on temporary_uploads (session, expires_at)`.execute(schema.db);
  },
  down: async (schema) => {
    await sql`drop index if exists temporary_uploads_session_expires_at_index`.execute(schema.db);
    await sql`drop index if exists temporary_uploads_expires_at_index`.execute(schema.db);
  },
});
