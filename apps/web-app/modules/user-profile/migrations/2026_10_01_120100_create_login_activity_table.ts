import { defineMigration } from '@bespokecore/database';

// When each user last signed in — this module's own table; `users` belongs to auth.
export default defineMigration({
  up: (schema) =>
    schema.create('login_activity', (table) => {
      table.foreignId('user_id').primary().constrained('users').cascadeOnDelete();
      table.timestamp('last_login_at');
    }),
  down: (schema) => schema.drop('login_activity'),
});
