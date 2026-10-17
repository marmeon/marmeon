// @marmeon-stub notifications 2
import { defineMigration } from '@marmeon/database';
import { notificationsTableConnection } from '@marmeon/notifications';

// The notifications' table under the name the framework reserves: notifications becomes marmeon_notifications, with its
// indexes and constraints. The rows stay. Stop every process of the old release — web, workers, scheduler, cron jobs —
// before `marmeon migrate`: one that keeps running fails on the new name. The index over the recipient and `created_at` gets
// a name of its own: with the new prefix its default name is longer than the 63 bytes Postgres keeps.
const LONG = 'notifications_recipient_type_recipient_id_created_at_index';
const SHORT = 'marmeon_notifications_recipient_created_index';
const COLUMNS = ['recipient_type', 'recipient_id', 'created_at'];

export default defineMigration({
  connection: notificationsTableConnection,
  up: async (schema) => {
    await schema.alter('notifications', (table) => {
      table.dropIndex(LONG);
      table.index(COLUMNS, SHORT);
    });
    await schema.rename('notifications', 'marmeon_notifications', { indexes: true });
  },
  down: async (schema) => {
    await schema.rename('marmeon_notifications', 'notifications', { indexes: true });
    await schema.alter('notifications', (table) => {
      table.dropIndex('notifications_recipient_created_index');
      table.index(COLUMNS, LONG);
    });
  },
});
