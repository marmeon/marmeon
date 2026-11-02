import type { Schema } from './schema.ts';

declare const schema: Schema;

schema.alter('guest_categories', (table) => {
  table.foreign('form_id').constrained('forms').nullOnDelete().inverse('categories');
  table.foreign('owner_id').constrained();
  // @ts-expect-error — the action on delete comes after constrained()
  table.foreign('team_id').nullOnDelete();
  // @ts-expect-error — the column exists already: nothing to modify
  table.foreign('seat_id').constrained().nullable();
});
