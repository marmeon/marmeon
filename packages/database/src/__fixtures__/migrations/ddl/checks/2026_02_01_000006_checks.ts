import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('ddl_checked', (table) => {
      table.id();
      table.string('role').oneOf('admin', "o'brien").default('admin');
      table.string('state', 20).nullable().oneOf('open', 'closed');
      table.integer('seats').default(1);
      table.check('ddl_checked_seats_check', 'seats > 0');
    });
    schema.alter('ddl_checked', (table) => table.text('kind').oneOf('a', 'b').default('a'));
  },
  down: () => {},
});
