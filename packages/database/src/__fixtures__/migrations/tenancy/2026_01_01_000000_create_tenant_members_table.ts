import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('tenant_members', (table) => {
      table.id();
      table.integer('tenant_id');
      table.string('email');
      table.unique(['tenant_id', 'email']);
    }),
  down: (schema) => schema.drop('tenant_members'),
});
