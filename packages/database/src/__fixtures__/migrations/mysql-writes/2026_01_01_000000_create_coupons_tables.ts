import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    // Two unique indexes on one table, and a primary key the database generates.
    schema.create('coupons', (table) => {
      table.id();
      table.string('email').unique();
      table.string('code').unique();
      table.string('note').nullable();
    });
    // A primary key that is always the caller's value.
    schema.create('slots', (table) => {
      table.string('slug', 40).primary();
      table.integer('seats').default(0);
    });
    // A composite unique index, and one with a name of its own.
    schema.create('memberships', (table) => {
      table.id();
      table.integer('team_id');
      table.string('email');
      table.string('badge').nullable();
      table.unique(['team_id', 'email']);
      table.unique('badge', 'memberships_badge_custom');
    });
  },
  down: (schema) => {
    schema.drop('memberships');
    schema.drop('slots');
    schema.drop('coupons');
  },
});
