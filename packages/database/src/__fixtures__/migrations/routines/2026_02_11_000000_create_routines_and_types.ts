import { sql } from 'kysely';
import { defineMigration } from '../../../index.ts';

// Everything a migration can leave behind besides tables; it fails with "already exists" when run twice on one database.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`create type mood as enum ('happy', 'sad')`);
    schema.raw(sql`create domain positive as integer check (value > 0)`);
    schema.raw(sql`create sequence ticket_numbers`);
    schema.raw(sql`create type floatrange as range (subtype = float8)`);
    schema.raw(sql`create type pricerange as range (subtype = numeric, multirange_type_name = price_spans)`);
    schema.raw(sql`create table tickets (id integer primary key, mood mood, amount positive)`);
    schema.raw(sql`create function stamp_ticket() returns trigger language plpgsql as $$ begin new.id := nextval('ticket_numbers'); return new; end $$`);
    schema.raw(sql`create function stamp_ticket(extra integer) returns integer language sql as 'select 1'`);
    schema.raw(sql`create trigger stamp_ticket before insert on tickets for each row execute function stamp_ticket()`);
  },
  down: (schema) => {
    schema.raw(sql`drop table tickets`);
    schema.raw(sql`drop function stamp_ticket(integer)`);
    schema.raw(sql`drop function stamp_ticket()`);
    schema.raw(sql`drop sequence ticket_numbers`);
    schema.raw(sql`drop type pricerange`);
    schema.raw(sql`drop type floatrange`);
    schema.raw(sql`drop domain positive`);
    schema.raw(sql`drop type mood`);
  },
});
