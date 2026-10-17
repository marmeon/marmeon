alter table "ddl_indexed" add column "d" varchar(255);
alter table "ddl_indexed" add column "e" integer default 0 not null;
alter table "ddl_indexed" add column "s" varchar(255);
alter table "ddl_indexed" add column "deleted_at" timestamptz(3);
alter table "ddl_indexed" add column "quoted" varchar(255) default 'it''s' not null;
alter table "ddl_indexed" add column "off" boolean default false not null;
alter table "ddl_indexed" add column "due" timestamptz(3) default '2026-01-02T03:04:05.678Z' not null;
alter table "ddl_indexed" add column "ddl_category_id" bigint references "ddl_categories" ("id");
create index "ddl_indexed_d_index" on "ddl_indexed" ("d");
create unique index "ddl_indexed_e_unique_name" on "ddl_indexed" ("e");
drop index "ddl_indexed_a_index";
drop index "ddl_indexed_named_ab";
alter table "ddl_indexed" rename column "b" to "bee";
alter table "ddl_indexed" add column "public_id" uuid default (encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid) not null;
drop index "ddl_indexed_d_index";
alter table "ddl_indexed" drop column "d";
-- marmeon_table_owners
-- {"module":"ddl","table_name":"ddl_categories"}
-- {"module":"ddl","table_name":"ddl_codes"}
-- {"module":"ddl","table_name":"ddl_indexed"}
-- {"module":"ddl","table_name":"ddl_keys"}
-- {"module":"ddl","table_name":"ddl_kinds"}
-- {"module":"ddl","table_name":"ddl_modifiers"}
-- {"module":"ddl","table_name":"ddl_people"}
-- marmeon_secret_columns
-- {"column_name":"api_key","table_name":"ddl_modifiers"}
-- {"column_name":"password","table_name":"ddl_modifiers"}
-- {"column_name":"s","table_name":"ddl_indexed"}
-- marmeon_schema_markers
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_indexed","value":null}
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_modifiers","value":null}
-- {"column_name":"","marker":"timestamps","table_name":"ddl_modifiers","value":null}
-- {"column_name":"editor_id","marker":"inverse","table_name":"ddl_keys","value":"edited_keys"}
