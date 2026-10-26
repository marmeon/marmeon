import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('webhook_events', (table) => {
      table.id();
      // The sender's id of the event. The unique index lets the first delivery in and refuses every repeat, however many arrive at once.
      table.string('event_id', 255).unique();
      table.string('type', 100);
      table.timestamps();
    }),
  down: (schema) => schema.drop('webhook_events'),
});
