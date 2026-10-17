create table "ddl_old" ("id" integer primary key autoincrement, "title" varchar(255) not null, "created_at" datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null, "updated_at" datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null);
create index "ddl_old_title_index" on "ddl_old" ("title");
alter table "ddl_people" rename to "ddl_persons";
alter table "ddl_old" rename to "ddl_new";
drop index "ddl_old_title_index";
CREATE INDEX "ddl_new_title_index" on "ddl_new" ("title");
