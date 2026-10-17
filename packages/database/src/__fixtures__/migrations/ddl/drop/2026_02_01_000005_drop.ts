import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: async (schema) => {
    await schema.drop('ddl_kinds');
    await schema.dropIfExists('ddl_new');
    await schema.dropIfExists('ddl_gone');
  },
  down: () => {},
});
