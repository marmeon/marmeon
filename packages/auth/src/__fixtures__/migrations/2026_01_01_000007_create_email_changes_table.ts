import { defineMigration } from '@marmeon/database';

// What the starter kit writes for the change-of-address store — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('email_changes', (table) => {
      table.bigInteger('user_id').primary();
      table.string('email', 255);
      table.string('token_hash', 64).secret();
      table.string('session_key', 64).nullable().secret();
      table.timestamp('expires_at');
      table.timestamp('created_at');
    }),
  down: (schema) => schema.drop('email_changes'),
});
