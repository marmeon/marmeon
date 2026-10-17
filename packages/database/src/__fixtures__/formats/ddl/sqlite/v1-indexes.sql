create table "ddl_indexed" ("id" integer primary key autoincrement, "a" varchar(255) not null, "b" varchar(255) not null, "c" varchar(255) not null);
create unique index "ddl_indexed_c_unique" on "ddl_indexed" ("c");
create index "ddl_indexed_a_index" on "ddl_indexed" ("a");
create index "ddl_indexed_a_b_index" on "ddl_indexed" ("a", "b");
create index "ddl_indexed_named_b" on "ddl_indexed" ("b");
create unique index "ddl_indexed_a_unique" on "ddl_indexed" ("a");
create unique index "ddl_indexed_named_ab" on "ddl_indexed" ("a", "b");
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
-- marmeon_schema_markers
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_modifiers","value":null}
-- {"column_name":"","marker":"timestamps","table_name":"ddl_modifiers","value":null}
-- {"column_name":"editor_id","marker":"inverse","table_name":"ddl_keys","value":"edited_keys"}
