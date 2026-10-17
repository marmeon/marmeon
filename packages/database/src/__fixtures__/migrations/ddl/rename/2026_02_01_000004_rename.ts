import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: async (schema) => {
    await schema.create('ddl_old', (table) => {
      table.id();
      table.string('title').secret();
      table.timestamps();
      table.index('title');
    });
    await schema.rename('ddl_people', 'ddl_persons');
    await schema.rename('ddl_old', 'ddl_new', { indexes: true });
  },
  down: () => {},
});
