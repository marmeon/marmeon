create table "ddl_old" ("id" integer primary key autoincrement, "title" varchar(255) not null, "created_at" datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null, "updated_at" datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null);
create index "ddl_old_title_index" on "ddl_old" ("title");
alter table "ddl_people" rename to "ddl_persons";
alter table "ddl_old" rename to "ddl_new";
drop index "ddl_old_title_index";
CREATE INDEX "ddl_new_title_index" on "ddl_new" ("title");
-- marmeon_table_owners
-- {"module":"ddl","table_name":"ddl_categories"}
-- {"module":"ddl","table_name":"ddl_codes"}
-- {"module":"ddl","table_name":"ddl_indexed"}
-- {"module":"ddl","table_name":"ddl_keys"}
-- {"module":"ddl","table_name":"ddl_kinds"}
-- {"module":"ddl","table_name":"ddl_modifiers"}
-- {"module":"ddl","table_name":"ddl_new"}
-- {"module":"ddl","table_name":"ddl_persons"}
-- marmeon_secret_columns
-- {"column_name":"api_key","table_name":"ddl_modifiers"}
-- {"column_name":"password","table_name":"ddl_modifiers"}
-- {"column_name":"s","table_name":"ddl_indexed"}
-- {"column_name":"title","table_name":"ddl_new"}
-- marmeon_schema_markers
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_indexed","value":null}
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_modifiers","value":null}
-- {"column_name":"","marker":"timestamps","table_name":"ddl_modifiers","value":null}
-- {"column_name":"","marker":"timestamps","table_name":"ddl_new","value":null}
-- {"column_name":"editor_id","marker":"inverse","table_name":"ddl_keys","value":"edited_keys"}
