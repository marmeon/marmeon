import { defineMigration } from '../../../index.ts';
import { softDeleteFilter } from '../../../schema-resolver.ts';

// A data step that reads the table the same plan created, with its soft-delete mark: it sees the schema as the plan has changed it so far.
export default defineMigration({
  up: (schema) => {
    schema.create('items', (table) => {
      table.id();
      table.string('name');
      table.string('token').nullable().secret();
      table.softDeletes();
    });
    schema.create('seen', (table) => {
      table.id();
      table.integer('visible');
      table.integer('columns');
    });
    schema.data(async (db) => {
      await db.insertInto('items').values([{ name: 'kept' }, { name: 'gone', deleted_at: new Date() }]).execute();
      const visible = await db.selectFrom('items').select('name').where(softDeleteFilter('items')).execute();
      const row = await db.selectFrom('items').selectAll().executeTakeFirstOrThrow();
      await db.insertInto('seen').values({ visible: visible.length, columns: Object.keys(row).length }).execute();
    });
  },
  down: (schema) => {
    schema.drop('seen');
    schema.drop('items');
  },
});
