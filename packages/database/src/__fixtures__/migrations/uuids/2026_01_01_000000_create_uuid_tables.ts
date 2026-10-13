import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: async (schema) => {
    // Pattern 1: the UUID is the primary key.
    await schema.create('teams', (table) => {
      table.uuidId();
      table.string('name');
    });
    await schema.create('members', (table) => {
      table.uuidId();
      table.foreignUuid('team_id').constrained().cascadeOnDelete();
      table.string('name');
    });
    // Pattern 2: an integer key for relations, a UUID for the outside.
    await schema.create('profiles', (table) => {
      table.id();
      table.uuid('public_id').unique().useUuidv7();
      table.string('name');
    });
  },
  down: async (schema) => {
    await schema.drop('members');
    await schema.drop('teams');
    await schema.drop('profiles');
  },
});
