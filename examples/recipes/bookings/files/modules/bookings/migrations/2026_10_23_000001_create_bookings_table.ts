import { defineMigration, sql } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    schema.create('bookings', (table) => {
      table.id();
      table.foreignId('room_id').constrained().cascadeOnDelete();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      // The booking holds the room from `starts_at` up to, but not including, `ends_at`.
      table.timestamp('starts_at');
      table.timestamp('ends_at');
      table.timestamps();
    });
    // Postgres: the database itself refuses two bookings of one room whose periods overlap, however many requests race. The
    // half-open range lets one booking end at the minute the next one starts, and `btree_gist` lets a gist index compare
    // `room_id` with `=`. SQLite has no such constraint (the statements are skipped there): its single writer makes the check
    // in BookingRepository enough.
    schema.raw({ pgsql: sql`create extension if not exists btree_gist` });
    // An empty period overlaps nothing, so a row with `starts_at >= ends_at` has to be refused on its own.
    schema.raw({ pgsql: sql`alter table bookings add constraint bookings_period check (starts_at < ends_at)` });
    schema.raw({ pgsql: sql`alter table bookings add constraint bookings_no_overlap exclude using gist (room_id with =, tstzrange(starts_at, ends_at) with &&)` });
  },
  down: (schema) => schema.drop('bookings'),
});
