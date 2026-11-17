import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('ddl_pages', (table) => {
      table.id();
      table.string('slug');
      table.string('locale');
      table.string('stage');
      table.boolean('featured').default(false);
      table.integer('rank').default(0);
      table.string('note').nullable();
      table.softDeletes();
      table.unique(['slug', 'locale'], { where: { stage: 'live' } });
      table.index('slug', { name: 'ddl_pages_alive', where: { deleted_at: null } });
      table.index('rank', { name: 'ddl_pages_featured_rank', where: { featured: true, rank: 3 } });
      table.unique('slug', { name: 'ddl_pages_featured_unique', where: { featured: true } });
      table.index('slug', { name: 'ddl_pages_quoted', where: { stage: "it's" } });
    });
    schema.alter('ddl_pages', (table) => {
      table.index('slug', { name: 'ddl_pages_noted', where: { note: { not: null }, featured: false } });
    });
  },
  down: () => {},
});
