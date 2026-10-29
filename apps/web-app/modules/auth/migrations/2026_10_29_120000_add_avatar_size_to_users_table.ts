import { defineMigration } from '@marmeon/database';

/** The avatar's width and height in pixels, read from the file when it was uploaded (`dimensions()`) — null without a picture or a readable header. */
export default defineMigration({
  up: (schema) =>
    schema.alter('users', (table) => {
      table.integer('avatar_width').nullable();
      table.integer('avatar_height').nullable();
    }),
  down: (schema) =>
    schema.alter('users', (table) => {
      table.dropColumn('avatar_width');
      table.dropColumn('avatar_height');
    }),
});
