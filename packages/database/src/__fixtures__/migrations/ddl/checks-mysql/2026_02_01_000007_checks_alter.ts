import { defineMigration } from '../../../../index.ts';

// SQLite cannot change a constraint in place: this group is loaded on MySQL only.
export default defineMigration({
  up: (schema) => {
    schema.alter('ddl_checked', (table) => {
      table.dropCheck('ddl_checked_seats_check');
      table.check('ddl_checked_seats_check', 'seats between 1 and 9');
    });
    schema.alter('ddl_checked', (table) => table.oneOf('role', ['admin', 'owner', "o'brien"]));
  },
  down: () => {},
});
