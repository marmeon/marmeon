import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.alter('profile_links', (table) => {
      table.boolean('featured').default(false);
      // At most one featured link per user: unique among the featured rows only (a user still has many links).
      table.unique('user_id', { name: 'profile_links_one_featured_per_user', where: { featured: true } });
    }),
  down: (schema) =>
    schema.alter('profile_links', (table) => {
      table.dropUnique('profile_links_one_featured_per_user');
      table.dropColumn('featured');
    }),
});
