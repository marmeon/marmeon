// @marmeon-stub notifications 2
import { defineMigration } from '@marmeon/database';
import { notificationsTableConnection } from '@marmeon/notifications';

// The table of the `database` notification channel: a row per notification and recipient. The id is the notification's
// own, the same over every attempt of its job — a second delivery finds the row and stops.
export default defineMigration({
  // NOTIFICATIONS_CONNECTION: where the database channel and the Inbox look.
  connection: notificationsTableConnection,
  up: async (schema) => {
    await schema.create('marmeon_notifications', (table) => {
      table.uuid('id').primary();
      table.string('recipient_type', 64);
      table.string('recipient_id', 64);
      table.string('type');
      table.json('data');
      table.timestamp('read_at').nullable();
      table.timestamp('created_at');
      table.index(['recipient_type', 'recipient_id', 'read_at']);
      // Named: the default name is longer than the 63 bytes Postgres keeps.
      table.index(['recipient_type', 'recipient_id', 'created_at'], 'marmeon_notifications_recipient_created_index');
      // For the prune: read ones by when they were read, unread ones by when they came.
      table.index('read_at');
      table.index('created_at');
    });
  },
  down: async (schema) => {
    await schema.drop('marmeon_notifications');
  },
});
