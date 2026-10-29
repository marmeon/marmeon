import { defineMigration, sql } from '@marmeon/database';

// An append-only log: no statement but INSERT passes. On SQLite a trigger of another table writes a row for every delete, to see
// that it does not run while the tables are emptied.
export default defineMigration({
  up: (schema) => {
    schema.create('audit_logs', (table) => {
      table.id();
      table.string('entry');
    });
    schema.create('orders', (table) => {
      table.id();
    });
    schema.create('order_trail', (table) => {
      table.id();
      table.integer('order_id');
    });
    schema.raw({
      pgsql: sql`create function refuse_audit_changes() returns trigger language plpgsql as $$ begin raise exception 'audit_logs is append-only'; end $$`,
    });
    schema.raw({ pgsql: sql`create trigger audit_logs_no_truncate before truncate on audit_logs for each statement execute function refuse_audit_changes()` });
    schema.raw({ pgsql: sql`create trigger audit_logs_no_change before update or delete on audit_logs for each row execute function refuse_audit_changes()` });
    schema.raw({ sqlite: sql`create trigger audit_logs_no_change before delete on audit_logs begin select raise(abort, 'audit_logs is append-only'); end` });
    schema.raw({ sqlite: sql`create trigger orders_trail after delete on orders begin insert into order_trail (order_id) values (old.id); end` });
  },
  down: (schema) => {
    schema.drop('order_trail');
    schema.drop('orders');
    schema.drop('audit_logs');
    schema.raw({ pgsql: sql`drop function refuse_audit_changes()` });
  },
});
