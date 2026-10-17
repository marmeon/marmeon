import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    // Pattern 1: the UUID is the primary key.
    schema.create('teams', (table) => {
      table.uuidId();
      table.string('name');
    });
    schema.create('members', (table) => {
      table.uuidId();
      table.foreignUuid('team_id').constrained().cascadeOnDelete();
      table.string('name');
    });
    // Pattern 2: an integer key for relations, a UUID for the outside.
    schema.create('profiles', (table) => {
      table.id();
      table.uuid('public_id').unique().useUuidv7();
      table.string('name');
    });
  },
  down: (schema) => {
    schema.drop('members');
    schema.drop('teams');
    schema.drop('profiles');
  },
});
