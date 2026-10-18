import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.alter('members', (table) => {
      table.dropUnique('members_slug_nickname_unique');
      table.dropUnique('members_nickname_unique');
      table.dropColumn('nickname');
      table.dropColumn('pin');
    }),
});
