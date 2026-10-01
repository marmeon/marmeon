import { defineMigration } from '@bespokecore/database';

/** The language a user chose (the switcher) — mails reach them in it, and a new device starts in it. */
export default defineMigration({
  up: (schema) => schema.alter('users', (table) => table.string('locale', 35).nullable()),
  down: (schema) => schema.alter('users', (table) => table.dropColumn('locale')),
});
