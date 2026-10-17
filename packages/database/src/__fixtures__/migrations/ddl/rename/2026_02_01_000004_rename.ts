import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('ddl_old', (table) => {
      table.id();
      table.string('title').secret();
      table.timestamps();
      table.index('title');
    });
    schema.rename('ddl_people', 'ddl_persons');
    schema.rename('ddl_old', 'ddl_new', { indexes: true });
  },
  down: () => {},
});
