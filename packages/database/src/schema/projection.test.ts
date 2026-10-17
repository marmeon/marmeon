import { readdirSync } from 'node:fs';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { drivers, freshConnections, type TestDriver } from '../__fixtures__/databases.ts';
import { isBookkeepingName } from '../bookkeeping.ts';
import { introspect, tableColumns, type CatalogQuery } from '../introspection.ts';
import { Migrator, type Connections } from '../index.ts';
import { kindOf } from '../metadata.ts';
import { columnType } from '../types-gen/render.ts';
import { applyPlan, emptyProjection, factsOf, projectMigrations, type ProjectedTable, type SchemaProjection } from './projection.ts';
import { planOf } from './plan.ts';
import type { Schema } from './schema.ts';

type Up = (schema: Schema) => void;

/** The projection after migrations given as `up` functions, each in a module of its own choosing. */
function project(...ups: (Up | [Up, string])[]): SchemaProjection {
  return ups.reduce<SchemaProjection>((projection, entry, i) => {
    const [up, module] = typeof entry === 'function' ? [entry, 'app'] : entry;
    return applyPlan(projection, planOf({ up }, 'up'), { name: `m${i}`, module });
  }, emptyProjection);
}

const table = (projection: SchemaProjection, name: string): ProjectedTable => {
  const found = projection.tables.get(name);
  if (!found) throw new Error(`no table ${name} in the projection`);
  return found;
};
const names = (t: ProjectedTable) => t.columns.map((column) => column.name);

describe('the projection of a plan', () => {
  it('knows the columns, keys and marks of a created table, and its owner', () => {
    const projection = project([
      (schema) => {
        schema.create('users', (t) => {
          t.id();
          t.string('email', 100).unique();
          t.string('password').secret();
          t.boolean('active').default(true);
          t.uuid('public_id').useUuidv7().nullable();
          t.timestamps();
          t.softDeletes();
          t.unique(['email', 'password'], 'users_pair');
          t.index('active');
        });
        schema.create('posts', (t) => {
          t.id();
          t.foreignId('user_id').constrained().cascadeOnDelete().inverse('written');
        });
      },
      'auth',
    ]);
    const users = table(projection, 'users');
    expect(users).toMatchObject({ module: 'auth', markers: ['soft_deletes', 'timestamps'] });
    expect(names(users)).toEqual(['id', 'email', 'password', 'active', 'public_id', 'created_at', 'updated_at', 'deleted_at']);
    expect(users.columns[0]).toMatchObject({ type: { sqlite: 'integer', pgsql: 'bigint' }, primary: true, identity: true, nullable: false });
    expect(users.columns[1]).toMatchObject({ type: { sqlite: 'varchar(100)', pgsql: 'varchar(100)' } });
    expect(users.columns[2]).toMatchObject({ secret: true, default: null });
    expect(users.columns[3]).toMatchObject({ default: 'value' });
    expect(users.columns[4]).toMatchObject({ nullable: true, default: 'uuidv7' });
    expect(users.columns[5]).toMatchObject({ default: 'now', type: { sqlite: 'datetime', pgsql: 'timestamptz(3)' } });
    expect(users.uniques).toEqual([['id'], ['email'], ['email', 'password']]);
    expect(users.indexes.map((index) => index.name)).toEqual(['users_email_unique', 'users_pair', 'users_active_index']);
    expect(table(projection, 'posts').foreignKeys).toEqual([{ column: 'user_id', references: 'users', referenced: 'id', onDelete: 'cascade', inverse: 'written'}]);
  });

  it('refuses to create a name twice, but takes it again after a drop', () => {
    const create: Up = (schema) => schema.create('users', (t) => t.id());
    expect(() => project(create, create)).toThrow(/creates table "users", which an earlier migration created/);
    expect(table(project(create, (s) => s.drop('users'), create), 'users').columns).toHaveLength(1);
    expect(project(create, (s) => s.dropIfExists('users'), (s) => s.dropIfExists('users')).tables.size).toBe(0);
  });

  it('keeps nothing of a dropped table when it is created again', () => {
    const projection = project(
      (s) => s.create('notes', (t) => { t.id(); t.string('body').secret(); t.timestamps(); }),
      (s) => s.drop('notes'),
      (s) => s.create('notes', (t) => t.id()),
    );
    expect(table(projection, 'notes')).toMatchObject({ markers: [], uniques: [['id']] });
    expect(names(table(projection, 'notes'))).toEqual(['id']);
  });

  it('takes the secrets, marks and owner of a renamed table along, and the foreign keys that point at it follow', () => {
    const projection = project(
      [(s) => { s.create('drafts', (t) => { t.id(); t.string('title').secret(); t.softDeletes(); }); s.create('parts', (t) => { t.foreignId('draft_id').constrained('drafts'); }); }, 'blog'],
      [(s) => s.rename('drafts', 'notes'), 'other'],
    );
    expect(projection.tables.has('drafts')).toBe(false);
    expect(table(projection, 'notes')).toMatchObject({ module: 'blog', markers: ['soft_deletes'] });
    expect(table(projection, 'notes').columns[1]!.secret).toBe(true);
    expect(table(projection, 'parts').foreignKeys[0]).toMatchObject({ references: 'notes' });
    expect(() => project((s) => { s.create('a', (t) => t.id()); s.create('b', (t) => t.id()); s.rename('a', 'b'); })).toThrow(/is the name of another table/);
  });

  it('renames the indexes of a renamed table only when asked to', () => {
    const create: Up = (s) => s.create('notes', (t) => { t.id(); t.string('slug').unique(); });
    expect(table(project(create, (s) => s.rename('notes', 'memos')), 'memos').indexes.map((i) => i.name)).toEqual(['notes_slug_unique']);
    expect(table(project(create, (s) => s.rename('notes', 'memos', { indexes: true })), 'memos').indexes.map((i) => i.name)).toEqual(['memos_slug_unique']);
  });

  it('renames a column where it is, and the secret, the inverse name and the keys follow it', () => {
    const projection = project(
      (s) => { s.create('users', (t) => { t.id(); t.string('email'); }); },
      (s) => s.create('notes', (t) => { t.id(); t.string('pw').secret(); t.string('tag').unique(); t.foreignId('user_id').constrained().inverse('notes_of'); t.integer('last'); }),
      (s) => s.alter('notes', (t) => { t.renameColumn('pw', 'password'); t.renameColumn('tag', 'label'); t.renameColumn('user_id', 'owner_id'); }),
      (s) => s.alter('users', (t) => t.renameColumn('id', 'key')),
    );
    const notes = table(projection, 'notes');
    expect(names(notes)).toEqual(['id', 'password', 'label', 'owner_id', 'last']);
    expect(notes.columns[1]!.secret).toBe(true);
    expect(notes.uniques).toEqual([['id'], ['label']]);
    expect(notes.indexes[0]!.columns).toEqual(['label']);
    expect(notes.foreignKeys[0]).toMatchObject({ column: 'owner_id', inverse: 'notes_of', referenced: 'key' });
  });

  it('loses the table mark when its column is renamed or dropped', () => {
    const create: Up = (s) => s.create('notes', (t) => { t.id(); t.timestamps(); t.softDeletes(); });
    expect(table(project(create, (s) => s.alter('notes', (t) => t.renameColumn('deleted_at', 'gone_at'))), 'notes').markers).toEqual(['timestamps']);
    expect(table(project(create, (s) => s.alter('notes', (t) => t.renameColumn('updated_at', 'changed_at'))), 'notes').markers).toEqual(['soft_deletes']);
    expect(table(project(create, (s) => s.alter('notes', (t) => t.dropColumn('created_at'))), 'notes').markers).toEqual(['soft_deletes']);
  });

  it('drops a column with its secret, key, indexes and unique sets', () => {
    const projection = project(
      (s) => s.create('users', (t) => t.id()),
      (s) => s.create('notes', (t) => { t.id(); t.string('a').secret().unique(); t.string('b'); t.foreignId('user_id').constrained(); t.unique(['a', 'b']); t.index('user_id'); }),
      (s) => s.alter('notes', (t) => { t.dropColumn('a'); t.dropColumn('user_id'); }),
    );
    const notes = table(projection, 'notes');
    expect(names(notes)).toEqual(['id', 'b']);
    expect(notes.foreignKeys).toEqual([]);
    expect(notes.indexes).toEqual([]);
    expect(notes.uniques).toEqual([['id']]);
  });

  it('drops an index by name, and with it the unique set', () => {
    const projection = project(
      (s) => s.create('notes', (t) => { t.id(); t.string('slug').unique(); }),
      (s) => s.alter('notes', (t) => t.dropUnique('notes_slug_unique')),
    );
    expect(table(projection, 'notes').uniques).toEqual([['id']]);
  });

  it('adds columns last, in the order alter executes: renames first, then new columns, NOT NULL changes, drops last', () => {
    const projection = project(
      (s) => s.create('notes', (t) => { t.id(); t.string('title').nullable(); t.string('old'); t.string('keep').nullable(); }),
      (s) =>
        s.alter('notes', (t) => {
          t.string('added').nullable();
          t.renameColumn('title', 'headline');
          // After the rename, before the drop: the new name is the one NOT NULL names, and a column dropped in the same step can be changed first.
          t.notNull('headline');
          t.nullable('old');
          t.notNull('keep');
          t.dropColumn('old');
        }),
    );
    const notes = table(projection, 'notes');
    expect(names(notes)).toEqual(['id', 'headline', 'keep', 'added']);
    expect(notes.columns.map((c) => c.nullable)).toEqual([false, false, false, true]);
  });

  it('does not take a primary key for nullable', () => {
    const keyed = table(project((s) => s.create('notes', (t) => t.uuid('k').primary().nullable())), 'notes');
    expect(keyed.columns[0]).toMatchObject({ primary: true, nullable: false });
  });

  it('changes nothing for raw SQL and data steps: what raw SQL makes is unknown to it', () => {
    const projection = project(
      (s) => s.create('notes', (t) => t.id()),
      (s) => {
        s.raw(sql`alter table notes add column extra text`);
        s.raw(sql`create table made_by_hand (id integer)`);
        s.data(async () => {});
      },
    );
    expect([...projection.tables.keys()]).toEqual(['notes']);
    expect(names(table(projection, 'notes'))).toEqual(['id']);
    // Dropping what nothing made known is nothing to the projection.
    expect(project((s) => s.drop('made_by_hand'), (s) => s.dropIfExists('made_by_hand')).tables.size).toBe(0);
  });

  it('refuses to change what no migration created with the blueprint, so that no mark is lost', () => {
    const create: Up = (s) => s.create('notes', (t) => t.id());
    expect(() => project((s) => s.alter('made_by_hand', (t) => { t.string('token').secret(); t.softDeletes(); }))).toThrow(/D19.*table "made_by_hand", which no migration created with the blueprint/s);
    expect(() => project((s) => s.rename('made_by_hand', 'other'))).toThrow(/D19.*table "made_by_hand"/s);
    expect(() => project(create, (s) => s.alter('notes', (t) => t.renameColumn('extra', 'more')))).toThrow(/D19.*column "notes.extra"/s);
    expect(() => project(create, (s) => s.alter('notes', (t) => t.notNull('extra')))).toThrow(/D19.*column "notes.extra"/s);
    expect(() => project(create, (s) => s.alter('notes', (t) => t.nullable('extra')))).toThrow(/D19.*column "notes.extra"/s);
    expect(() => project(create, (s) => s.alter('notes', (t) => t.index('extra')))).toThrow(/D19.*column "notes.extra"/s);
    expect(() => project(create, (s) => s.alter('notes', (t) => t.integer('id')))).toThrow(/D19.*has it already/s);
    // A column added in the same alter is known to what follows it.
    expect(names(table(project(create, (s) => s.alter('notes', (t) => { t.string('slug').nullable(); t.index('slug'); t.notNull('slug'); })), 'notes'))).toEqual(['id', 'slug']);
  });

  it('lists the migrations it was computed from', () => {
    expect(project((s) => s.create('a', (t) => t.id()), [(s) => s.create('b', (t) => t.id()), 'mod']).migrations).toEqual([
      { name: 'm0', module: 'app' },
      { name: 'm1', module: 'mod' },
    ]);
  });

  it('is not changed by a later plan', () => {
    const before = project((s) => s.create('a', (t) => t.id()));
    applyPlan(before, planOf({ up: (s) => s.drop('a') }, 'up'), { name: 'x', module: 'app' });
    expect(before.tables.has('a')).toBe(true);
  });

  it('gives the relations code the same facts it reads from a catalog', () => {
    const facts = factsOf(
      project(
        (s) => s.create('users', (t) => { t.id(); t.string('token').secret(); t.softDeletes(); }),
        (s) => s.create('posts', (t) => { t.id(); t.foreignId('user_id').constrained().inverse('written').nullable(); }),
      ),
      'sqlite',
    );
    expect(facts.foreignKeys).toEqual([{ table: 'posts', column: 'user_id', references: 'users', referenced: 'id', nullable: true }]);
    expect(facts.markers).toEqual([
      { table: 'posts', column: 'user_id', marker: 'inverse', value: 'written' },
      { table: 'users', column: '', marker: 'soft_deletes', value: null },
    ]);
    expect(facts.secretColumns).toEqual([{ table: 'users', column: 'token' }]);
    expect(facts.columns.get('users')).toEqual(['id', 'token', 'deleted_at']);
    expect(facts.types.get('posts')!.get('user_id')).toBe('integer');
    expect(factsOf(project((s) => s.create('posts', (t) => t.id())), 'pgsql').types.get('posts')!.get('id')).toBe('bigint');
  });
});

// ---- the projection against the catalog of a migrated database ----

const fixtureRoot = new URL('../__fixtures__/migrations/', import.meta.url);
const fixtures = (name: string): ModuleDefinition => ({ name: name.replaceAll('/', '-'), migrations: new URL(`${name}/`, fixtureRoot) });

/** Migrations that run together on a fresh database; each fixture directory is in one group at least. */
const GROUPS: Record<string, string[]> = {
  accounts: ['accounts'],
  blog: ['auth', 'blog'],
  plurals: ['plurals'],
  uuids: ['uuids'],
  system: ['system'],
  elsewhere: ['elsewhere'],
  'lock-lost': ['lock-lost'],
  'lock-lost-elsewhere': ['lock-lost-elsewhere'],
  markers: ['auth', 'markers'],
  relations: ['auth', 'relations'],
  'relations-ambiguous': ['auth', 'relations-ambiguous'],
  'relations-secrets': ['auth', 'relations-secrets'],
  'relations-readers': ['auth', 'relations', 'relations-readers'],
  'relations-archived': ['auth', 'relations', 'relations-archived'],
  // The DDL groups build on each other: the later ones alter, rename and drop what the first made.
  'ddl-columns': ['ddl/columns'],
  'ddl-indexes': ['ddl/columns', 'ddl/indexes'],
  ddl: ['ddl/columns', 'ddl/indexes', 'ddl/alter', 'ddl/rename', 'ddl/drop'],
  nullability: ['nullability'],
  'renamed-key': ['renamed-key'],
};
/** Directories loaded on Postgres only, next to their group (SQLite cannot do what they do). */
const PGSQL_ONLY: Record<string, string[]> = { markers: ['markers-pgsql'], nullability: ['nullability-pgsql'], ddl: ['ddl/alter-pgsql'] };
/** Directories no parity is asked of: they fail on purpose, or write what the projection does not know. */
const EXCLUDED = ['broken', 'raw-alter', 'raw-rename-column', 'raw-rename-table', 'writes-books'];

const appMigrations = (app: string): ModuleDefinition[] => {
  const modules = new URL(`../../../../apps/${app}/modules/`, import.meta.url);
  return readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => (readdirSync(new URL(`${entry.name}/`, modules)).includes('migrations') ? [{ name: entry.name, migrations: new URL(`${entry.name}/migrations/`, modules) }] : []));
};

const catalog = (connections: Connections): CatalogQuery => async (text) => (await sql.raw(text).execute(connections.get())).rows as never;

/** `table\0column` → what the database does when the referenced row goes, in the words of the blueprint. */
async function onDelete(run: CatalogQuery, driver: TestDriver): Promise<Map<string, string>> {
  const rows =
    driver === 'sqlite'
      ? await run<{ t: string; c: string; action: string }>(`select m.name as t, f."from" as c, lower(f.on_delete) as action from sqlite_master m join pragma_foreign_key_list(m.name) f where m.type = 'table'`)
      : await run<{ t: string; c: string; action: string }>(`select c.conrelid::regclass::text as t, a.attname::text as c,
          case c.confdeltype when 'c' then 'cascade' when 'n' then 'set null' when 'r' then 'restrict' when 'a' then 'no action' else c.confdeltype::text end as action
          from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.contype = 'f' and array_length(c.conkey, 1) = 1`);
  return new Map(rows.map((row) => [`${row.t}\0${row.c}`, row.action]));
}

/** The columns (`table\0column`) with a default or an identity. SQLite has AUTOINCREMENT in the statement of the table only. */
async function generatedColumns(run: CatalogQuery, driver: TestDriver): Promise<Set<string>> {
  const rows =
    driver === 'sqlite'
      ? await run<{ t: string; c: string; generated: number | boolean }>(`select m.name as t, p.name as c, (p.dflt_value is not null or (p.pk = 1 and m.sql like '%autoincrement%')) as generated
          from sqlite_master m join pragma_table_info(m.name) p where m.type = 'table'`)
      : await run<{ t: string; c: string; generated: number | boolean }>(`select table_name::text as t, column_name::text as c, (column_default is not null or is_identity = 'YES') as generated
          from information_schema.columns where table_schema = current_schema()`);
  return new Set(rows.filter((row) => row.generated === true || row.generated === 1).map((row) => `${row.t}\0${row.c}`));
}

/** Migrates `modules` on a fresh database and compares the projection with what the database says. */
async function expectParity(driver: TestDriver, modules: ModuleDefinition[]): Promise<void> {
  const { connections, close } = await freshConnections(driver);
  try {
    const migrator = new Migrator({ modules, root: '/' } as unknown as Application, connections).onOneConnection();
    await migrator.migrate();
    const projection = await migrator.projection();
    const run = catalog(connections);
    const real = await introspect(run, driver);
    const all = await tableColumns(run, driver);
    const mine = factsOf(projection, driver);
    const own = (name: string) => !isBookkeepingName(name) && name !== 'sqlite_sequence';
    const tables = projection.tables;

    // Tables, columns and their order.
    expect([...all.types.keys()].filter(own).sort()).toEqual([...tables.keys()].sort());
    for (const [name, types] of all.types) {
      if (!own(name)) continue;
      const projected = tables.get(name)!;
      expect(projected.columns.map((c) => c.name), `columns of ${name}`).toEqual([...types.keys()]);
      for (const [column, type] of types) {
        const declared = mine.types.get(name)!.get(column)!;
        expect(columnType(declared, driver), `${name}.${column}: ${declared} against ${type}`).toBe(columnType(type, driver));
        expect(kindOf(declared), `${name}.${column}`).toEqual(kindOf(type));
        expect(projected.columns.find((c) => c.name === column)!.nullable, `${name}.${column} nullable`).toBe(all.nullable.has(`${name}\0${column}`));
      }
    }
    // Keys and the relations' facts.
    expect(mine.foreignKeys).toEqual(real.foreignKeys.filter((key) => own(key.table)));
    expect(Object.fromEntries(mine.uniques)).toEqual(Object.fromEntries([...real.uniques].filter(([name]) => own(name))));
    // What happens to a row of the referenced table, and which columns the database fills in when an insert gives none.
    const deletes = await onDelete(run, driver);
    for (const table of tables.values()) {
      for (const key of table.foreignKeys) {
        expect(key.onDelete ?? 'no action', `${table.name}.${key.column} on delete`).toBe(deletes.get(`${table.name}\0${key.column}`));
      }
    }
    const generated = await generatedColumns(run, driver);
    for (const table of tables.values()) {
      for (const column of table.columns) {
        expect(column.default !== null || column.identity, `${table.name}.${column.name} has a default or is generated`).toBe(generated.has(`${table.name}\0${column.name}`));
      }
    }
    // What the migrator's books say today.
    expect(mine.secretColumns.toSorted((a, b) => `${a.table}.${a.column}` < `${b.table}.${b.column}` ? -1 : 1)).toEqual(real.secretColumns.toSorted((a, b) => `${a.table}.${a.column}` < `${b.table}.${b.column}` ? -1 : 1));
    expect(mine.markers).toEqual(real.markers);
    // The owners are the books' owners.
    const owners = await migrator.owners();
    expect(new Map([...tables.values()].map((t) => [t.name, t.module]))).toEqual(new Map([...owners].filter(([name]) => own(name))));
  } finally {
    await close();
  }
}

describe.each(drivers)('the projection against the catalog on %s', (driver) => {
  const groupModules = (group: string) => [...GROUPS[group]!, ...(driver === 'pgsql' ? (PGSQL_ONLY[group] ?? []) : [])].map(fixtures);

  for (const group of Object.keys(GROUPS)) {
    it(`matches the database that the fixture group "${group}" migrates`, async () => {
      await expectParity(driver, groupModules(group));
    });
  }

  it('matches the database that the migrations of the web app migrate', async () => {
    await expectParity(driver, appMigrations('web-app'));
  });

  it('matches the database that the migrations of the blank app migrate', async () => {
    await expectParity(driver, appMigrations('blank-app'));
  });

  it('stops a migration before it runs when it changes a table that raw SQL made', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      const migrator = new Migrator({ modules: [fixtures('raw-alter')], root: '/' } as unknown as Application, connections);
      await expect(migrator.migrate()).rejects.toThrow(/D19.*"legacy"/s);
      expect((await connections.get<any>().introspection.getTables()).map((t) => t.name)).not.toContain('legacy');
    } finally {
      await close();
    }
  });

  it('does not know a column that raw SQL added', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      const migrator = new Migrator({ modules: [fixtures('accounts')], root: '/' } as unknown as Application, connections);
      await migrator.migrate();
      await sql`alter table accounts add column by_hand text`.execute(connections.get());
      const projection = await migrator.projection();
      const real = await tableColumns(catalog(connections), driver);
      expect([...real.types.get('accounts')!.keys()]).toContain('by_hand');
      expect(names(table(projection, 'accounts'))).not.toContain('by_hand');
    } finally {
      await close();
    }
  });
});

describe('the fixtures', () => {
  it('are all in a group of the parity test, or excluded from it with a reason', () => {
    const directories = readdirSync(fixtureRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const nested = directories.flatMap((name) => (name === 'ddl' ? readdirSync(new URL('ddl/', fixtureRoot)).map((sub) => `ddl/${sub}`) : [name]));
    const covered = new Set([...Object.values(GROUPS).flat(), ...Object.values(PGSQL_ONLY).flat(), ...EXCLUDED]);
    expect(nested.filter((name) => !covered.has(name))).toEqual([]);
  });

  it('project to the tables the groups of the parity test name', async () => {
    const files = new Migrator({ modules: [fixtures('auth'), fixtures('blog')], root: '/' } as unknown as Application, undefined as never).files();
    expect([...(await projectMigrations(files)).tables.keys()]).toEqual(['users', 'articles']);
    expect([...(await projectMigrations(files, { only: new Set([files[0]!.name]) })).tables.keys()]).toEqual(['users']);
  });
});
