import { defineMigration } from '@marmeon/database';

// The accounts that asked, with one click from a mail, to get no more digest mails — this module's own table; `users` belongs to auth.
export default defineMigration({
  up: (schema) =>
    schema.create('notification_opt_outs', (table) => {
      table.foreignId('user_id').primary().constrained('users').cascadeOnDelete();
      table.timestamp('created_at');
    }),
  down: (schema) => schema.drop('notification_opt_outs'),
});
