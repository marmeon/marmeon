import { defineMigration } from '@bespokecore/database';

/** Where a user's avatar is on the public disk (`avatars/<random>.webp`) — set from the profile's edit layer, null without one. */
export default defineMigration({
  up: (schema) => schema.alter('users', (table) => table.string('avatar_path', 255).nullable()),
  down: (schema) => schema.alter('users', (table) => table.dropColumn('avatar_path')),
});
