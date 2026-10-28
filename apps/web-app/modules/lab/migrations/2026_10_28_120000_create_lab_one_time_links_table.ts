import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('lab_one_time_links', (table) => {
      table.uuidId();
      // Only the hash of the link's token (`linkToken()`): a copy of this table opens no link. `.secret()` keeps it out of every `select *`.
      table.string('token_hash', 64).secret().unique();
      table.timestamp('used_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('lab_one_time_links'),
});
