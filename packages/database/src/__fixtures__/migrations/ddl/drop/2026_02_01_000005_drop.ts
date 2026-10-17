import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.drop('ddl_kinds');
    schema.dropIfExists('ddl_new');
    schema.dropIfExists('ddl_gone');
  },
  down: () => {},
});
