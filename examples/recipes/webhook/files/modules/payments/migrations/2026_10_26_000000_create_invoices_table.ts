import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('invoices', (table) => {
      table.id();
      table.string('reference', 80).unique();
      table.integer('amount_cents');
      table.timestamp('paid_at').nullable();
      table.timestamp('receipt_issued_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('invoices'),
});
