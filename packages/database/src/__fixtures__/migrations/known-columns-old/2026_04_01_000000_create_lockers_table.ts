import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('lockers', (table) => {
      table.id();
      table.string('name');
    });
    schema.create('status', (table) => {
      table.id();
      table.string('status');
    });
    schema.create('items', (table) => {
      table.id();
      table.foreignId('locker_id').constrained().cascadeOnDelete();
      table.string('label');
    });
  },
  down: (schema) => {
    schema.drop('items');
    schema.drop('status');
    schema.drop('lockers');
  },
});
