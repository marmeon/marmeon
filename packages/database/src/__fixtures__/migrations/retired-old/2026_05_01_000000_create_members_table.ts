import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('teams', (table) => table.id());
    schema.create('members', (table) => {
      table.id();
      table.string('name');
      table.string('nickname').nullable().unique();
      table.string('pin').nullable().secret();
      table.string('badge').default('none');
      table.foreignId('team_id').constrained().nullable();
      table.string('slug');
      table.unique(['slug', 'nickname']);
    });
  },
  down: (schema) => {
    schema.drop('members');
    schema.drop('teams');
  },
});
