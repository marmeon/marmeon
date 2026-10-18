import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.alter('members', (table) => {
      table.retire('nickname');
      table.retire('pin');
      table.retire('badge');
      table.retire('team_id');
    }),
});
