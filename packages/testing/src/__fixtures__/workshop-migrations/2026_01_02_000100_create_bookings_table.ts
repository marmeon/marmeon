import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('bookings', (table) => {
      table.id();
      table.foreignId('workshop_id').constrained('workshops').cascadeOnDelete();
      table.string('guest');
    }),
  down: (schema) => schema.drop('bookings'),
});
