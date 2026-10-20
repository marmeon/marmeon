create table "migrations" ("id" integer primary key autoincrement, "name" varchar(255) not null unique, "module" varchar(255) not null, "batch" integer not null, "checksum" varchar(80));
create table "accounts" ("id" integer primary key autoincrement, "email" varchar(255) not null, "password" varchar(255) not null, "api_secret" varchar(255), "created_at" datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null, "updated_at" datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null);
create unique index "accounts_email_unique" on "accounts" ("email");
insert into "migrations" ("name", "module", "batch", "checksum") values ('2026_01_05_000000_create_accounts_table', 'accounts', 1, 'sha256:0000000000000000000000000000000000000000000000000000000000000000');
insert into "accounts" ("email", "password") values ('ada@example.com', 'hash-of-ada');
