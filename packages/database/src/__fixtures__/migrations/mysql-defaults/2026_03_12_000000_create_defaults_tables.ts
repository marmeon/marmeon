import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('defaults', (table) => {
      table.id();
      table.text('note').default("it's a \\ back\\slash 'quoted' and \"double\"");
      table.json('settings').default({ list: ["q'uote", 'back\\slash', 1], on: true });
      table.timestamp('opened_at').default(new Date('2026-10-01T08:00:00.123Z'));
      table.timestamp('stamped').useCurrent();
      table.string('kind').default('plain');
    });
    schema.create('owners', (table) => {
      table.id();
      table.string('name');
    });
    schema.create('pets', (table) => {
      table.id();
      table.string('name');
    });
  },
});
