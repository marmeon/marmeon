import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('rooms', (table) => {
      table.id();
      table.string('name', 60);
      table.timestamps();
    }),
  down: (schema) => schema.drop('rooms'),
});
