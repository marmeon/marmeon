import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.alter('ddl_indexed', (table) => {
      table.string('d').nullable();
      table.integer('e').default(0);
      table.string('s').nullable().secret();
      table.softDeletes();
      table.string('quoted').default("it's");
      table.boolean('off').default(false);
      table.timestamp('due').default(new Date('2026-01-02T03:04:05.678Z'));
      table.foreignId('ddl_category_id').constrained().nullable();
      table.index('d');
      table.unique('e', 'ddl_indexed_e_unique_name');
    });
    schema.alter('ddl_indexed', (table) => {
      table.dropIndex('ddl_indexed_a_index');
      table.dropUnique('ddl_indexed_named_ab');
      table.renameColumn('b', 'bee');
    });
  },
  down: () => {},
});
