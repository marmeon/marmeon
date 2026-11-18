import { readFileSync } from 'node:fs';
import type { Application } from '@marmeon/core';
import { Output, type CommandInput } from 'marmeon';
import { Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { freshConnections, freshDatabase, MYSQL_URL, silent, withMysql } from './__fixtures__/databases.ts';
import { DbShowCommand } from './commands/db-show.ts';
import { MigrateStatusCommand } from './commands/migrate.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections } from './connections.ts';
import { deriveRelations, introspect, tableColumns } from './introspection.ts';
import { migrationChecksum } from './migrations/checksum.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { LOCK_TABLE } from './migrations/lock.ts';
import { Migrator } from './migrations/migrator.ts';
import { migratorConnection } from './migrator-connection.ts';
import { createMysqlDialect } from './mysql.ts';
import { factsOf, projectMigrations } from './schema/projection.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const root = workspaceTempDir('marmeon-mysql-catalog-app-');

// The catalog of MySQL is read in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL; the file is skipped without it.
// The tables are made by SQL here: what a migration makes on MySQL is not what these tests are about.

type MysqlOptions = Extract<ConnectionOptions, { driver: 'mysql' }>;
/** The database a connection's URL names. */
const nameOf = (options: ConnectionOptions): string => new URL((options as MysqlOptions).url!).pathname.slice(1);
const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const migrator = (connections: Connections, ...names: string[]) =>
  new Migrator({ modules: names.map((name) => ({ name, migrations: fixtures(name) })), root } as unknown as Application, connections);

/** The tables of the relation fixtures, as the migrations of `__fixtures__/migrations/relations` make them on the other drivers. */
const RELATION_TABLES = [
  'create table users (id bigint primary key auto_increment, email varchar(190) not null unique)',
  'create table posts (id bigint primary key auto_increment, author_id bigint not null, editor_id bigint null, constraint foreign key (author_id) references users (id) on delete cascade, constraint foreign key (editor_id) references users (id) on delete set null)',
  'create table comments (id bigint primary key auto_increment, post_id bigint not null, user_id bigint not null, constraint foreign key (post_id) references posts (id) on delete cascade, constraint foreign key (user_id) references users (id) on delete cascade)',
  'create table tags (id bigint primary key auto_increment, slug varchar(190) not null unique)',
  'create table post_tag (post_id bigint not null, tag_id bigint not null, unique key (post_id, tag_id), constraint foreign key (post_id) references posts (id) on delete cascade, constraint foreign key (tag_id) references tags (id) on delete cascade)',
  'create table post_stats (post_id bigint primary key, views int not null default 0, constraint foreign key (post_id) references posts (id) on delete cascade)',
  'create table categories (id bigint primary key auto_increment, parent_id bigint null, constraint foreign key (parent_id) references categories (id) on delete set null)',
];

withMysql('the catalog of MySQL', () => {
  describe('the facts of an unmanaged connection', () => {
    let connections: Connections;
    let close: () => Promise<void>;
    const run = <R>(query: string) => sql.raw<R>(query).execute(connections.get()).then((result) => result.rows);

    beforeAll(async () => {
      ({ connections, close } = await freshConnections('mysql', { managed: false }));
      for (const statement of RELATION_TABLES) await sql.raw(statement).execute(connections.get());
    });
    afterAll(() => close());

    it('reads the foreign keys and unique column sets of the relation fixtures as the other drivers do', async () => {
      const found = await introspect(run, 'mysql');
      expect(found.foreignKeys).toEqual([
        { table: 'categories', column: 'parent_id', references: 'categories', referenced: 'id', nullable: true },
        { table: 'comments', column: 'post_id', references: 'posts', referenced: 'id', nullable: false },
        { table: 'comments', column: 'user_id', references: 'users', referenced: 'id', nullable: false },
        { table: 'post_stats', column: 'post_id', references: 'posts', referenced: 'id', nullable: false },
        { table: 'post_tag', column: 'post_id', references: 'posts', referenced: 'id', nullable: false },
        { table: 'post_tag', column: 'tag_id', references: 'tags', referenced: 'id', nullable: false },
        { table: 'posts', column: 'author_id', references: 'users', referenced: 'id', nullable: false },
        { table: 'posts', column: 'editor_id', references: 'users', referenced: 'id', nullable: true },
      ]);
      expect(Object.fromEntries(found.uniques)).toEqual({
        categories: [['id']],
        comments: [['id']],
        post_stats: [['post_id']],
        post_tag: [['post_id', 'tag_id']],
        posts: [['id']],
        tags: [['id'], ['slug']],
        users: [['email'], ['id']],
      });
      expect(Object.fromEntries(found.primaryKeys)).toEqual({
        categories: ['id'],
        comments: ['id'],
        post_stats: ['post_id'],
        posts: ['id'],
        tags: ['id'],
        users: ['id'],
      });
    });

    it('derives the relations the other drivers derive from the same keys and the marks of the migrations', async () => {
      const modules = [{ name: 'auth', migrations: fixtures('auth') }, { name: 'blog', migrations: fixtures('relations') }];
      const projection = await projectMigrations(new Migrator({ modules, root } as unknown as Application, undefined as never).files());
      const derived = deriveRelations({ ...(await introspect(run, 'mysql')), markers: factsOf(projection, 'mysql').markers });
      expect(derived.problems).toEqual([]);
      const names = Object.fromEntries([...derived.relations].map(([table, relations]) => [table, Object.fromEntries([...relations].map(([name, r]) => [name, r.kind]))]));
      expect(names).toEqual({
        categories: { categories: 'hasMany', parent: 'belongsTo' },
        comments: { post: 'belongsTo', user: 'belongsTo' },
        post_stats: { post: 'belongsTo' },
        post_tag: { post: 'belongsTo', tag: 'belongsTo' },
        posts: { author: 'belongsTo', comments: 'hasMany', editor: 'belongsTo', post_stats: 'hasOne', post_tag: 'hasMany', tags: 'belongsToMany' },
        tags: { post_tag: 'hasMany', posts: 'belongsToMany' },
        users: { authored_posts: 'hasMany', comments: 'hasMany', edited_posts: 'hasMany' },
      });
    });

    it('leaves out a foreign key of two columns, a unique index on a prefix or an expression, and a view', async () => {
      const db = connections.get();
      await sql`create table parents (a int not null, b int not null, primary key (a, b))`.execute(db);
      await sql`create table children (id int primary key, a int not null, b int not null, note varchar(40) not null, constraint foreign key (a, b) references parents (a, b))`.execute(db);
      await sql`create unique index children_note_prefix on children (note(8))`.execute(db);
      await sql`create unique index children_expression on children ((a + b))`.execute(db);
      await sql`create view children_view as select id from children`.execute(db);
      try {
        const found = await introspect(run, 'mysql');
        expect(found.foreignKeys.filter((key) => key.table === 'children')).toEqual([]);
        expect(found.uniques.get('children')).toEqual([['id']]);
        expect(found.uniques.get('parents')).toEqual([['a', 'b']]);
        expect(found.columns.has('children_view')).toBe(false);
        expect(found.primaryKeys.has('children_view')).toBe(false);
      } finally {
        await sql`drop view children_view`.execute(db);
        await sql`drop table children, parents`.execute(db);
      }
    });

    it('has no primary key for a table whose key is on a prefix of a column', async () => {
      const db = connections.get();
      await sql`create table pk_prefix (k varchar(20) collate utf8mb4_0900_ai_ci not null, primary key (k(1)))`.execute(db);
      try {
        const found = await introspect(run, 'mysql');
        expect(found.primaryKeys.has('pk_prefix')).toBe(false);
        expect(found.uniques.has('pk_prefix')).toBe(false);
        expect(found.columns.get('pk_prefix')).toEqual(['k']);
      } finally {
        await sql`drop table pk_prefix`.execute(db);
      }
    });

    it('keeps the order of the columns of a key, not the order of their names', async () => {
      const db = connections.get();
      await sql`create table ordered (a int not null, b int not null, c int not null, primary key (b, a), unique key (c, b))`.execute(db);
      try {
        const found = await introspect(run, 'mysql');
        expect(found.primaryKeys.get('ordered')).toEqual(['b', 'a']);
        expect(found.uniques.get('ordered')).toEqual([['b', 'a'], ['c', 'b']]);
      } finally {
        await sql`drop table ordered`.execute(db);
      }
    });

    it('does not take a prefix index for a unique one: the server lets two values that compare equal in, and a full unique index does not', async () => {
      const db = connections.get();
      // The database is `utf8mb4_0900_bin`, where 'ß' and 'ss' differ and a full unique index takes both: the column's own collation counts.
      await sql`create table prefixed (id int primary key, k varchar(20) collate utf8mb4_0900_ai_ci not null, unique key (k(1)))`.execute(db);
      await sql`create table whole (id int primary key, k varchar(20) collate utf8mb4_0900_ai_ci not null, unique key (k))`.execute(db);
      try {
        // Under utf8mb4_0900_ai_ci 'ß' = 'ss', and the prefixes 'ß' and 's' differ: the prefix index lets both in.
        await sql`insert into prefixed (id, k) values (1, ${'ßa'}), (2, ${'ssa'})`.execute(db);
        await sql`insert into whole (id, k) values (1, ${'ßa'})`.execute(db);
        const refused = await sql`insert into whole (id, k) values (2, ${'ssa'})`.execute(db).then(() => undefined, (caught: unknown) => caught);
        expect(refused).toMatchObject({ errno: 1062 });
        const found = await introspect(run, 'mysql');
        expect(found.uniques.get('prefixed')).toEqual([['id']]);
        expect(found.uniques.get('whole')).toEqual([['id'], ['k']]);
      } finally {
        await sql`drop table prefixed, whole`.execute(db);
      }
    });
  });

  describe('a second database on the same server', () => {
    it('reads only the database of the connection: no table, no foreign key of another one, in either direction', async () => {
      const { connections, close } = await freshConnections('mysql', { managed: false });
      const other = await freshDatabase('mysql', { managed: false });
      const otherName = nameOf(other.options);
      const ownName = nameOf(connections.options());
      const db = connections.get();
      const run = <R>(query: string) => sql.raw<R>(query).execute(db).then((result) => result.rows);
      const away = new Connections({ connections: { default: other.options }, root: '/', logger: silent });
      try {
        await sql`create table users (id bigint primary key)`.execute(db);
        await sql`create table elsewhere (id bigint primary key)`.execute(away.get());
        // A key from here to there, and a key from there to here.
        await sql`create table child (id bigint primary key, other_id bigint not null, constraint foreign key (other_id) references ${sql.id(otherName, 'elsewhere')} (id))`.execute(db);
        await sql`create table outside (id bigint primary key, user_id bigint not null, constraint foreign key (user_id) references ${sql.id(ownName, 'users')} (id))`.execute(away.get());
        const found = await introspect(run, 'mysql');
        expect([...found.columns.keys()].toSorted()).toEqual(['child', 'users']);
        expect(found.foreignKeys).toEqual([]);
        expect([...found.uniques.keys()]).toEqual(['child', 'users']);
        expect([...found.primaryKeys.keys()]).toEqual(['child', 'users']);
      } finally {
        await sql`drop table if exists outside`.execute(away.get());
        await sql`drop table if exists child`.execute(db);
        await away.destroy();
        await other.drop();
        await close();
      }
    });
  });

  describe('the schema metadata of an unmanaged connection', () => {
    it('reads the columns and keys from the catalog, and knows no secret column, no soft delete, no timestamps', async () => {
      const { connections, close } = await freshConnections('mysql', { managed: false });
      try {
        await sql`create table users (id int primary key, name varchar(255))`.execute(connections.get());
        await sql`create table pets (id int primary key, user_id int not null, constraint foreign key (user_id) references users (id))`.execute(connections.get());
        await connections.get<any>().selectFrom('users').select('id').execute();
        const metadata = connections.metadata();
        expect([...(metadata.kinds.get('users')?.keys() ?? [])]).toEqual(['id', 'name']);
        expect(metadata.secrets.size).toBe(0);
        expect(metadata.softDeletes.size).toBe(0);
        expect(metadata.timestamps.size).toBe(0);
        expect(metadata.primaryKeys.get('users')).toEqual(['id']);
        expect(metadata.relations.get('pets')?.get('user')).toMatchObject({ kind: 'belongsTo', table: 'users', foreignKey: 'user_id', targetKey: 'id' });
        expect(metadata.relations.get('users')?.get('pets')).toMatchObject({ kind: 'hasMany', table: 'pets', foreignKey: 'user_id' });
      } finally {
        await close();
      }
    });
  });

  describe('migrate:status', () => {
    // Guards the MySQL status path (`migrate` does not run on MySQL yet): the record is made and filled by hand.
    it('lists the migrations that ran with their batch and those that are pending', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      try {
        const start = migrator(connections, 'auth', 'accounts');
        await sql`create table migrations (id bigint primary key auto_increment, name varchar(255) not null unique, module varchar(255) not null, batch integer not null, checksum varchar(80)) default character set utf8mb4 collate utf8mb4_0900_bin`.execute(migratorConnection(connections));
        const file = start.files().find((f) => f.module === 'auth')!;
        await sql`insert into migrations (name, module, batch, checksum) values (${file.name}, 'auth', 1, ${migrationChecksum(readFileSync(file.path))})`.execute(migratorConnection(connections));
        const stdout: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
        try {
          const code = await new MigrateStatusCommand(start).handle({ args: [], options: { json: true }, output: new Output(), root: '/' } as unknown as CommandInput);
          expect(code).toBe(0);
        } finally {
          vi.restoreAllMocks();
        }
        const document = JSON.parse(stdout.join('')) as { migrations: { module: string; batch: number | null; status: string }[]; warnings: string[] };
        expect(document.migrations.map((m) => [m.module, m.batch, m.status])).toEqual([
          ['auth', 1, 'ran'],
          ['accounts', null, 'pending'],
          ['accounts', null, 'pending'],
        ]);
        expect(document.warnings).toEqual([]);
      } finally {
        await close();
      }
    });
  });

  describe('migrate:fresh (dropAllTables)', () => {
    // Tables and views from the catalog itself: `getTables()` leaves out a view whose table is gone.
    const tablesOf = async (connections: Connections) =>
      (await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by table_name`.execute(migratorConnection(connections))).rows.map((row) => row.name);

    it('empties a database whose tables have keys between them: a parent before its child, a table to itself, two tables to each other, and a view', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      const db = migratorConnection(connections);
      try {
        for (const statement of RELATION_TABLES) await sql.raw(statement).execute(db);
        await sql`create table a_owners (id int primary key)`.execute(db);
        await sql`create table z_pets (id int primary key, owner_id int not null, constraint foreign key (owner_id) references a_owners (id))`.execute(db);
        await sql`create table left_side (id int primary key, right_id int null)`.execute(db);
        await sql`create table right_side (id int primary key, left_id int null, constraint foreign key (left_id) references left_side (id))`.execute(db);
        await sql`alter table left_side add constraint foreign key (right_id) references right_side (id)`.execute(db);
        await sql`create view post_titles as select id from posts`.execute(db);
        expect((await tablesOf(connections)).length).toBe(7 + 4 + 1);

        await dropAllTables(db, 'mysql');
        expect(await tablesOf(connections)).toEqual([]);
        await dropAllTables(db, 'mysql'); // nothing to drop is no statement
      } finally {
        await close();
      }
    });

    it('drops a table whose name holds a dot, and not the table of that name in another database', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      const other = await freshDatabase('mysql', { managed: false });
      const otherName = nameOf(other.options);
      const db = migratorConnection(connections);
      const away = new Connections({ connections: { default: other.options }, root: '/', logger: silent });
      try {
        await sql`create table users (id int)`.execute(away.get());
        // `<other>.users` is a table of this database; read as a qualified name it would be the table of the other one.
        await sql`create table ${sql.id(`${otherName}.users`)} (id int)`.execute(db);
        await sql`create table ${sql.id('archive.2024')} (id int)`.execute(db);
        await dropAllTables(db, 'mysql');
        expect(await tablesOf(connections)).toEqual([]);
        expect((await away.get().introspection.getTables()).map((t) => t.name)).toEqual(['users']);
      } finally {
        await away.destroy();
        await other.drop();
        await close();
      }
    });

    it('works inside a transaction, which a drop commits', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      const db = migratorConnection(connections);
      try {
        await sql`create table owners (id int primary key)`.execute(db);
        await db.transaction().execute((trx) => dropAllTables(trx, 'mysql'));
        expect(await tablesOf(connections)).toEqual([]);
      } finally {
        await close();
      }
    });

    it('drops a table named like the lock of the other drivers: the lock of MySQL is a named lock, not a table', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      const db = migratorConnection(connections);
      try {
        await sql`create table ${sql.id(LOCK_TABLE)} (id int primary key)`.execute(db);
        await dropAllTables(db, 'mysql');
        expect(await tablesOf(connections)).toEqual([]);
      } finally {
        await close();
      }
    });

    it('drops a view whose table is gone already', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      const db = migratorConnection(connections);
      try {
        await sql`create table base (id int primary key)`.execute(db);
        await sql`create view base_ids as select id from base`.execute(db);
        await sql`drop table base`.execute(db);
        expect(await tablesOf(connections)).toEqual(['base_ids']);
        await dropAllTables(db, 'mysql');
        expect(await tablesOf(connections)).toEqual([]);
      } finally {
        await close();
      }
    });

    it('is refused by the server, and drops nothing, while a table of another database holds a key to one of its tables', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      const other = await freshDatabase('mysql', { managed: false });
      const db = migratorConnection(connections);
      const away = new Connections({ connections: { default: other.options }, root: '/', logger: silent });
      try {
        await sql`create table owners (id int primary key)`.execute(db);
        await sql`create table pets (id int primary key, owner_id int not null, constraint foreign key (owner_id) references owners (id))`.execute(db);
        await sql`create view owner_ids as select id from owners`.execute(db);
        await sql`create table visitors (id int primary key, owner_id int not null, constraint foreign key (owner_id) references ${sql.id(nameOf(connections.options()), 'owners')} (id))`.execute(away.get());
        const error = await dropAllTables(db, 'mysql').then(() => undefined, (caught: unknown) => caught);
        expect(error).toMatchObject({ errno: 3730 });
        expect(await tablesOf(connections)).toEqual(['owner_ids', 'owners', 'pets']); // the view too: tables go first
      } finally {
        await sql`drop table if exists visitors`.execute(away.get());
        await away.destroy();
        await other.drop();
        await close();
      }
    });
  });

  describe('db:show', () => {
    it('shows the version of the server, and the tables without the name of the database', async () => {
      const { connections, close } = await freshConnections('mysql', { record: false });
      try {
        await sql`create table things (id int primary key)`.execute(migratorConnection(connections));
        const version = (await sql<{ v: string }>`select @@version as v`.execute(migratorConnection(connections))).rows[0]!.v;
        const show = async (options: Record<string, string | boolean>) => {
          const stdout: string[] = [];
          vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
          try {
            await new DbShowCommand(connections).handle({ args: [], options, output: new Output(), root: '/' } as never);
          } finally {
            vi.restoreAllMocks();
          }
          return stdout.join('');
        };
        const text = await show({});
        expect(text).toContain(`Server      MySQL ${version}`);
        expect(text).toMatch(/^\s*things\s+1\s+0/m);
        const document = JSON.parse(await show({ json: true })) as { driver: string; server: string; tables: unknown[] };
        expect(document).toMatchObject({ driver: 'mysql', server: `MySQL ${version}` });
        expect(document.tables).toEqual([{ name: 'things', schema: null, columns: 1, rows: 0 }]);
      } finally {
        await close();
      }
    });
  });

  describe('a role with privileges on part of the database', () => {
    const admin = new Kysely<any>({ dialect: createMysqlDialect({ url: MYSQL_URL!, poolMax: 1 }) });
    const users: string[] = [];
    // Made at run time: a literal password in a test file is what secret scanners look for.
    const password = ['pw', crypto.randomUUID().replaceAll('-', '')].join('_');
    const dropUsers = async () => {
      for (const user of users.splice(0)) await sql`drop user if exists ${sql.lit(user)}@'%'`.execute(admin);
    };
    afterAll(async () => {
      await dropUsers();
      await admin.destroy();
    });

    /** A fresh database and a role with the grants (`on` is the database name). Both are dropped when the test ends. */
    async function withRole(grants: (database: string, user: string) => string[]) {
      const database = await freshDatabase('mysql', { managed: false });
      const options = database.options as MysqlOptions;
      const name = nameOf(options);
      const owner = new Connections({ connections: { default: options }, root: '/', logger: silent });
      const user = `marmeon_cat_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      users.push(user);
      let limited: Connections | undefined;
      onTestFinished(async () => {
        await limited?.destroy();
        await owner.destroy();
        await dropUsers();
        await database.drop();
      });
      return {
        owner,
        name,
        grant: async () => {
          await sql`create user ${sql.lit(user)}@'%' identified by ${sql.lit(password)}`.execute(admin);
          for (const grant of grants(name, user)) await sql.raw(grant).execute(admin);
          const url = new URL(options.url!);
          url.username = user;
          url.password = password;
          limited = new Connections({ connections: { default: { ...options, url: url.href } }, root: '/', logger: silent });
          return limited;
        },
      };
    }

    it('a table the role cannot see is missing from the reads of the catalog, with its keys', async () => {
      const { owner, grant } = await withRole((name, user) => [`grant select on ${'`' + name + '`'}.visible to '${user}'@'%'`]);
      await sql`create table visible (id int primary key, note varchar(20), hidden_id int null, unique key (note))`.execute(owner.get());
      await sql`create table hidden (id int primary key, token varchar(20), visible_id int null, unique key (token), constraint foreign key (visible_id) references visible (id))`.execute(owner.get());
      await sql`alter table visible add constraint foreign key (hidden_id) references hidden (id)`.execute(owner.get());
      const limited = await grant();

      const run = <R>(query: string) => sql.raw<R>(query).execute(migratorConnection(limited)).then((result) => result.rows);
      const { types } = await tableColumns(run, 'mysql');
      expect([...types.keys()]).toEqual(['visible']);
      const found = await introspect(run, 'mysql');
      expect([...found.columns.keys()]).toEqual(['visible']);
      expect(found.foreignKeys).toEqual([]); // `visible` to `hidden`: a relation to a table without columns
      expect(Object.fromEntries(found.uniques)).toEqual({ visible: [['id'], ['note']] });
      expect(Object.fromEntries(found.primaryKeys)).toEqual({ visible: ['id'] });
      // The migrator's own reading of the tables of the database: `hidden` is not among them, as if it had never been made.
      const { columns } = await migrator(limited).undescribedColumns('default', []);
      expect([...columns.keys()]).toEqual(['visible']);
    });

    it('does not read a key of two columns as one of a single column when the role sees the table but not all of its columns', async () => {
      const { owner, grant } = await withRole((name, user) => [`grant select on ${'`' + name + '`'}.docs to '${user}'@'%'`, `grant select (id, doc_id, body) on ${'`' + name + '`'}.notes to '${user}'@'%'`]);
      await sql`create table docs (tenant_id int not null, id int not null, primary key (tenant_id, id))`.execute(owner.get());
      await sql`create table notes (id int primary key, tenant_id int not null, doc_id int not null, body varchar(20), constraint foreign key (tenant_id, doc_id) references docs (tenant_id, id))`.execute(owner.get());
      const limited = await grant();

      const run = <R>(query: string) => sql.raw<R>(query).execute(migratorConnection(limited)).then((result) => result.rows);
      const found = await introspect(run, 'mysql');
      expect([...found.columns.keys()].toSorted()).toEqual(['docs', 'notes']);
      expect(found.foreignKeys).toEqual([]);
    });

    it('does not read a key of two columns as one of a single column when the role sees only its first column, though its target is unique alone', async () => {
      const { owner, grant } = await withRole((name, user) => [`grant select on ${'`' + name + '`'}.owners to '${user}'@'%'`, `grant select (id, owner_id) on ${'`' + name + '`'}.children to '${user}'@'%'`]);
      // `owners.id` is unique alone; the key to (id, discriminator) needs the second index, and `discriminator` may be null: such a child
      // with an `owner_id` that matches no owner is valid.
      await sql`create table owners (id int primary key, discriminator int null, unique key (id, discriminator))`.execute(owner.get());
      await sql`create table children (id int primary key, owner_id int not null, discriminator int null, constraint foreign key (owner_id, discriminator) references owners (id, discriminator))`.execute(owner.get());
      const limited = await grant();

      const run = <R>(query: string) => sql.raw<R>(query).execute(migratorConnection(limited)).then((result) => result.rows);
      const found = await introspect(run, 'mysql');
      expect([...found.columns.keys()].toSorted()).toEqual(['children', 'owners']);
      expect(found.foreignKeys).toEqual([]);
      expect(deriveRelations(found).relations.size).toBe(0);
    });

    it('does not read a key on the index of one column that names two columns, which the server takes with the check for it off — for the owner and for a role that sees one column', async () => {
      const { owner, grant } = await withRole((name, user) => [`grant select on ${'`' + name + '`'}.hid to '${user}'@'%'`, `grant select (pk, x) on ${'`' + name + '`'}.kid_hid to '${user}'@'%'`]);
      // Only in this session: with `restrict_fk_on_non_standard_key` on, the server refuses the key. InnoDB adds the primary key to the
      // index `a_u` unseen, so `(a, id)` is found on it, and a child `(x = 77, y = NULL)` has no parent and is valid.
      await owner.get().connection().execute(async (lease) => {
        await sql`set session restrict_fk_on_non_standard_key = off`.execute(lease);
        await sql`create table hid (a int not null, id int not null, primary key (id), unique key a_u (a))`.execute(lease);
        await sql`create table kid_hid (pk int primary key, x int null, y int null, constraint foreign key (x, y) references hid (a, id))`.execute(lease);
      });
      const limited = await grant();

      const own = <R>(query: string) => sql.raw<R>(query).execute(owner.get()).then((result) => result.rows);
      expect((await introspect(own, 'mysql')).foreignKeys).toEqual([]);
      const run = <R>(query: string) => sql.raw<R>(query).execute(migratorConnection(limited)).then((result) => result.rows);
      const found = await introspect(run, 'mysql');
      expect([...found.columns.get('kid_hid')!]).toEqual(['pk', 'x']);
      expect(found.foreignKeys).toEqual([]);
    });

    it('does not read a key to a column the role cannot see', async () => {
      const { owner, grant } = await withRole((name, user) => [`grant select (name) on ${'`' + name + '`'}.owners to '${user}'@'%'`, `grant select on ${'`' + name + '`'}.children to '${user}'@'%'`]);
      await sql`create table owners (id int primary key, name varchar(20))`.execute(owner.get());
      await sql`create table children (id int primary key, owner_id int not null, constraint foreign key (owner_id) references owners (id))`.execute(owner.get());
      const limited = await grant();

      const run = <R>(query: string) => sql.raw<R>(query).execute(migratorConnection(limited)).then((result) => result.rows);
      const found = await introspect(run, 'mysql');
      expect([...found.columns.get('owners')!]).toEqual(['name']);
      expect(found.foreignKeys).toEqual([]);
      expect(deriveRelations(found).relations.size).toBe(0);
    });

    it('still reads a foreign key to a primary key and to a unique index of one column, also for a role with privileges on single columns', async () => {
      const { owner, grant } = await withRole((name, user) => [`grant select on ${'`' + name + '`'}.users to '${user}'@'%'`, `grant select (id, user_id, email) on ${'`' + name + '`'}.logins to '${user}'@'%'`]);
      await sql`create table users (id int primary key, email varchar(100) not null unique)`.execute(owner.get());
      await sql`create table logins (id int primary key, user_id int not null, email varchar(100) not null, constraint foreign key (user_id) references users (id), constraint foreign key (email) references users (email))`.execute(owner.get());
      const limited = await grant();

      const run = <R>(query: string) => sql.raw<R>(query).execute(migratorConnection(limited)).then((result) => result.rows);
      expect((await introspect(run, 'mysql')).foreignKeys.map((key) => [key.table, key.column, key.references, key.referenced])).toEqual([
        ['logins', 'email', 'users', 'email'],
        ['logins', 'user_id', 'users', 'id'],
      ]);
    });

    it('empties the database for a role with every privilege on it, or refuses with the same error as for the owner when another database holds a key', async () => {
      const { owner, grant, name } = await withRole((database, user) => [`grant all on ${'`' + database + '`'}.* to '${user}'@'%'`]);
      const other = await freshDatabase('mysql', { managed: false });
      const away = new Connections({ connections: { default: other.options }, root: '/', logger: silent });
      onTestFinished(async () => {
        await sql`drop table if exists visitors`.execute(away.get());
        await away.destroy();
        await other.drop();
      });
      await sql`create table owners (id int primary key)`.execute(owner.get());
      const limited = await grant();
      // The role has no privilege on the other database, and the server still refuses.
      await sql`create table visitors (id int primary key, owner_id int not null, constraint foreign key (owner_id) references ${sql.id(name, 'owners')} (id))`.execute(away.get());
      const error = await dropAllTables(migratorConnection(limited), 'mysql').then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ errno: 3730 });
      expect((await migratorConnection(limited).introspection.getTables()).map((t) => t.name)).toEqual(['owners']);

      await sql`drop table visitors`.execute(away.get());
      await dropAllTables(migratorConnection(limited), 'mysql');
      expect(await migratorConnection(limited).introspection.getTables()).toEqual([]);
    });
  });
});
