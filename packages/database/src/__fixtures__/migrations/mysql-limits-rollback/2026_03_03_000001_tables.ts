import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('rb_parents', (table) => table.id());
    schema.create('rb_posts', (table) => table.id());
  },
  down: (schema) => {
    schema.drop('rb_posts');
    schema.drop('rb_parents');
  },
});
