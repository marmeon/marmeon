import { defineMigration } from '@marmeon/database';

// The table of LIVE_DRIVER=database: a row per hint (or per session that ended) between the processes of the app. `id` is the
// one sequence of all processes — a channel's number is the id of its last row. `channel` is the hinted channel (null for a
// session that ended), `message` the JSON message between nodes (the channel's hint with the names of the props to reload, or
// the scope of the session that ended), `created_at` the time in epoch milliseconds. A row never carries data — only names;
// the hubs of the processes poll the table, and each prunes the rows nobody needs any more.
export default defineMigration({
  up: (schema) => {
    schema.create('live_hints', (table) => {
      table.id();
      table.string('channel', 200).nullable();
      table.text('message');
      table.bigInteger('created_at');
      table.index(['channel', 'id']);
      table.index('created_at');
    });
  },
  down: (schema) => {
    schema.drop('live_hints');
  },
});
