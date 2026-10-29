import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.alter('ddl_checked', (table) => {
      table.dropCheck('ddl_checked_role_check');
      table.check('ddl_checked_role_check', "role in ('admin', 'owner')");
    });
  },
  down: () => {},
});
