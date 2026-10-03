import { defineMigration } from '@bespokecore/database';

// The table of the `database` notification channel (written by `bespoke make:notifications-table`): a row per notification
// and recipient — who it is for (`recipient_type` and `recipient_id`, as `{ type, id }` was sent), its name (`static
// notification`), what `toDatabase()` returned (JSON), when it was read (null: unread) and when it came. The id is the
// notification's own (a UUID, the same over every attempt of its job — a second delivery finds it and stops).
// The Inbox reads it, always for one recipient; `bespoke notifications:prune` empties it of old, read ones.
export default defineMigration({
  up: async (schema) => {
    await schema.create('notifications', (table) => {
      table.uuid('id').primary();
      table.string('recipient_type', 64);
      table.string('recipient_id', 64);
      table.string('type');
      table.json('data');
      table.timestamp('read_at').nullable();
      table.timestamp('created_at');
      table.index(['recipient_type', 'recipient_id', 'read_at']);
      table.index(['recipient_type', 'recipient_id', 'created_at']);
      // For the prune: read ones by when they were read, unread ones by when they came.
      table.index('read_at');
      table.index('created_at');
    });
  },
  down: async (schema) => {
    await schema.drop('notifications');
  },
});
