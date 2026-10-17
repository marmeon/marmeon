drop table "ddl_kinds";
drop table if exists "ddl_new";
drop table if exists "ddl_gone";
-- marmeon_table_owners
-- {"module":"ddl","table_name":"ddl_categories"}
-- {"module":"ddl","table_name":"ddl_codes"}
-- {"module":"ddl","table_name":"ddl_indexed"}
-- {"module":"ddl","table_name":"ddl_keys"}
-- {"module":"ddl","table_name":"ddl_modifiers"}
-- {"module":"ddl","table_name":"ddl_persons"}
-- marmeon_secret_columns
-- {"column_name":"api_key","table_name":"ddl_modifiers"}
-- {"column_name":"password","table_name":"ddl_modifiers"}
-- {"column_name":"s","table_name":"ddl_indexed"}
-- marmeon_schema_markers
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_indexed","value":null}
-- {"column_name":"","marker":"soft_deletes","table_name":"ddl_modifiers","value":null}
-- {"column_name":"","marker":"timestamps","table_name":"ddl_modifiers","value":null}
-- {"column_name":"editor_id","marker":"inverse","table_name":"ddl_keys","value":"edited_keys"}
