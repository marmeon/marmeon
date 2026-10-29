import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { drivers, freshConnections, type TestDriver } from '../__fixtures__/databases.ts';
import { deriveRelations, introspect, tableColumns, type CatalogQuery } from '../introspection.ts';
import { Migrator, type Connections } from '../index.ts';
import { isMigratorTable } from '../migration-state.ts';
import { loadMigration } from '../migrations/load.ts';
import { runMigration } from '../migrations/run.ts';
import { kindOf } from '../metadata.ts';
import { columnType } from '../types-gen/render.ts';
import { PROJECTION_FILE, forgetProjections } from './projection-file.ts';
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

  it('marks a table notPivot() and writes no field for any other', () => {
    const projection = project(
      (s) => { s.create('events', (t) => { t.id(); }); s.create('users', (t) => { t.id(); }); },
      (s) => s.create('guest_imports', (t) => { t.foreignId('event_id').constrained(); t.foreignId('user_id').constrained(); t.unique(['event_id', 'user_id']); t.notPivot(); }),
      (s) => s.create('tags', (t) => { t.foreignId('event_id').constrained(); t.foreignId('user_id').constrained(); t.unique(['event_id', 'user_id']); }),
    );
    expect(table(projection, 'guest_imports').pivot).toBe(false);
    expect('pivot' in table(projection, 'tags')).toBe(false);
    expect(JSON.stringify(table(projection, 'tags'))).not.toContain('pivot');
    const relations = deriveRelations(factsOf(projection, 'sqlite'));
    expect(relations.relations.get('events')?.get('users')).toMatchObject({ pivot: 'tags' });
    expect(relations.relations.get('guest_imports')?.get('event')).toMatchObject({ kind: 'belongsTo' });
  });

  it('keeps the notPivot() mark through alter and rename, and loses it with drop()', () => {
    const create: Up = (s) => s.create('files', (t) => { t.id(); t.string('path'); });
    const marked = project(create, (s) => s.alter('files', (t) => t.notPivot()));
    expect(table(marked, 'files').pivot).toBe(false);
    expect(table(project(create, (s) => s.alter('files', (t) => t.notPivot()), (s) => s.alter('files', (t) => { t.string('mime').nullable(); t.unique('path'); })), 'files').pivot).toBe(false);
    expect(table(project(create, (s) => s.alter('files', (t) => t.notPivot()), (s) => s.rename('files', 'documents')), 'documents').pivot).toBe(false);
    const again = project(create, (s) => s.alter('files', (t) => t.notPivot()), (s) => s.drop('files'), create);
    expect('pivot' in table(again, 'files')).toBe(false);
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

  describe('retiring a column', () => {
    const members = (s: Schema) =>
      s.create('members', (t) => {
        t.id();
        t.string('name');
        t.string('pin').nullable().secret();
        t.string('badge').default('none');
        t.string('nickname').nullable().unique();
        t.foreignId('team_id').constrained('teams').nullable();
        t.string('slug');
        t.unique(['slug', 'nickname']);
        t.timestamps();
      });
    const teams = (s: Schema) => s.create('teams', (t) => t.id());
    const retire = (...columns: string[]): Up => (s) => s.alter('members', (t) => columns.forEach((column) => t.retire(column)));

    it('keeps the column in the table but leaves it out of what Marmeon knows: columns, types, keys and unique sets', () => {
      const projection = project(teams, members, retire('badge', 'team_id', 'nickname'));
      const facts = factsOf(projection, 'sqlite');
      expect(names(table(projection, 'members'))).toEqual(['id', 'name', 'pin', 'badge', 'nickname', 'team_id', 'slug', 'created_at', 'updated_at']);
      expect(facts.columns.get('members')).toEqual(['id', 'name', 'pin', 'slug', 'created_at', 'updated_at']);
      expect([...facts.types.get('members')!.keys()]).toEqual(['id', 'name', 'pin', 'slug', 'created_at', 'updated_at']);
      expect(facts.foreignKeys.filter((key) => key.table === 'members')).toEqual([]);
      expect(table(projection, 'members').foreignKeys).toEqual([]);
      expect(table(projection, 'members').uniques).toEqual([['id']]);
      expect(Object.fromEntries(facts.uniques).members).toEqual([['id']]);
    });

    it('leaves a retired column out of the generated types, and a secret one stays secret in the facts', () => {
      const projection = project(teams, members, retire('pin'));
      expect(factsOf(projection, 'pgsql').secretColumns).toEqual([{ table: 'members', column: 'pin' }]);
      expect(factsOf(projection, 'pgsql').columns.get('members')).not.toContain('pin');
      expect(table(projection, 'members').columns.find((c) => c.name === 'pin')).toMatchObject({ secret: true, retired: true });
    });

    it('is dropped by a later dropColumn, which takes the secret mark with it', () => {
      const projection = project(teams, members, retire('pin', 'badge'), (s) => s.alter('members', (t) => { t.dropColumn('pin'); t.dropColumn('badge'); }));
      expect(names(table(projection, 'members'))).toEqual(['id', 'name', 'nickname', 'team_id', 'slug', 'created_at', 'updated_at']);
      expect(factsOf(projection, 'sqlite').secretColumns).toEqual([]);
      expect(table(projection, 'members').indexes.map((i) => i.name)).toEqual(['members_nickname_unique', 'members_slug_nickname_unique']);
    });

    it('may be named again once it is dropped', () => {
      const projection = project(teams, members, retire('pin'), (s) => s.alter('members', (t) => t.dropColumn('pin')), (s) => s.alter('members', (t) => t.string('pin').nullable()));
      expect(table(projection, 'members').columns.find((c) => c.name === 'pin')).toMatchObject({ secret: false });
      expect(table(projection, 'members').columns.find((c) => c.name === 'pin')!.retired).toBeUndefined();
    });

    it('refuses everything but a drop on a retired column (D19)', () => {
      const base = [teams, members, retire('badge')] as const;
      expect(() => project(...base, (s) => s.alter('members', (t) => t.renameColumn('badge', 'tag')))).toThrow(/D19.*"members\.badge".*retired/s);
      expect(() => project(...base, (s) => s.alter('members', (t) => t.notNull('badge')))).toThrow(/D19.*retired/s);
      expect(() => project(...base, (s) => s.alter('members', (t) => t.nullable('badge')))).toThrow(/D19.*retired/s);
      expect(() => project(...base, (s) => s.alter('members', (t) => t.index('badge')))).toThrow(/D19.*retired/s);
      expect(() => project(...base, (s) => s.alter('members', (t) => t.unique(['slug', 'badge'])))).toThrow(/D19.*retired/s);
      expect(() => project(...base, (s) => s.alter('members', (t) => t.string('badge')))).toThrow(/D19.*has it already/s);
      expect(() => project(...base, retire('badge'))).toThrow(/D19.*already retired|D19.*earlier migration retired/s);
    });

    it('refuses a column that is NOT NULL without a default, because the inserts of the new release would fail (D19)', () => {
      expect(() => project(teams, members, retire('slug'))).toThrow(/D19.*"members\.slug".*NOT NULL and has no default.*nullable/s);
      // Nullable, or with a default, the database fills it in (or leaves it NULL) when the insert does not know the column.
      expect(() => project(teams, members, retire('pin', 'badge'))).not.toThrow();
      expect(() => project(teams, members, (s) => s.alter('members', (t) => { t.nullable('slug'); t.retire('slug'); }))).not.toThrow();
    });

    it('refuses a column with a fixed default in a unique index: the second insert of the new release would write the same value (D19)', () => {
      const created = (s: Schema) => s.create('codes', (t) => { t.id(); t.string('slug'); t.string('code').default('none').unique(); t.timestamp('seen_at').useCurrent(); t.unique(['slug', 'seen_at']); });
      expect(() => project(created, (s) => s.alter('codes', (t) => t.retire('code')))).toThrow(/D19.*"codes\.code".*fixed default.*codes_code_unique.*dropUnique/s);
      expect(() => project(created, (s) => s.alter('codes', (t) => t.retire('seen_at')))).toThrow(/D19.*"codes\.seen_at".*codes_slug_seen_at_unique/s);
      // The index goes first, in this alter (dropped indexes come first) or an earlier one.
      expect(() => project(created, (s) => s.alter('codes', (t) => { t.dropUnique('codes_code_unique'); t.retire('code'); }))).not.toThrow();
      expect(() => project(created, (s) => s.alter('codes', (t) => t.dropUnique('codes_code_unique')), (s) => s.alter('codes', (t) => t.retire('code')))).not.toThrow();
      // A nullable column without a default may stay in a unique index: NULL is never equal to NULL.
      expect(() => project(teams, members, retire('nickname'))).not.toThrow();
    });

    it('refuses a foreign key that points at a retired column (D19)', () => {
      const owners = (s: Schema) => s.create('owners', (t) => { t.id(); t.bigInteger('code').nullable(); });
      const retired = (s: Schema) => s.alter('owners', (t) => t.retire('code'));
      expect(() => project(owners, retired, (s) => s.create('pets', (t) => { t.id(); t.foreignId('owner_code').constrained('owners', 'code'); }))).toThrow(/D19.*"pets\.owner_code".*"owners\.code".*retired/s);
      expect(() => project(owners, retired, (s) => s.create('pets', (t) => { t.id(); t.foreignId('owner_id').constrained('owners'); }))).not.toThrow();
      expect(() => project(owners, retired, (s) => s.create('pets', (t) => t.id()), (s) => s.alter('pets', (t) => t.foreignId('owner_code').constrained('owners', 'code')))).toThrow(/D19.*retired/s);
    });

    it('refuses a primary key, a mark column, a column that is not there and one another table references (D19)', () => {
      expect(() => project(teams, members, retire('id'))).toThrow(/D19.*primary key/s);
      expect(() => project(teams, members, retire('created_at'))).toThrow(/D19.*timestamps/s);
      expect(() => project(teams, members, retire('gone'))).toThrow(/D19.*"members\.gone"/s);
      expect(() =>
        project(
          (s) => s.create('owners', (t) => { t.id(); t.bigInteger('code').unique().default(1); }),
          (s) => s.create('pets', (t) => { t.id(); t.foreignId('owner_code').constrained('owners', 'code'); }),
          (s) => s.alter('owners', (t) => t.retire('code')),
        ),
      ).toThrow(/D19.*"owners\.code".*"pets" references/s);
    });

    it('changes nothing in the database: an alter that only retires has no statement', async () => {
      const { Blueprint, blueprintParts } = await import('./blueprint.ts');
      const blueprint = new Blueprint('members');
      blueprint.retire('pin');
      expect(blueprintParts(blueprint).retirements).toEqual(['pin']);
      blueprint.seal();
      expect(() => blueprint.retire('badge')).toThrow(/closed/);
    });

    it('works in alter() only', () => {
      expect(() => project((s) => s.create('members', (t) => { t.id(); t.retire('id'); }))).toThrow(/only work when changing a table/);
    });
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
  'slug-keys': ['slug-keys'],
  tenancy: ['tenancy'],
  system: ['system'],
  elsewhere: ['elsewhere'],
  'lock-lost': ['lock-lost'],
  'lock-lost-elsewhere': ['lock-lost-elsewhere'],
  markers: ['auth', 'markers'],
  relations: ['auth', 'relations'],
  'relations-ambiguous': ['auth', 'relations-ambiguous'],
  'relations-shadowed': ['auth', 'relations-shadowed'],
  'relations-named': ['auth', 'relations-named'],
  'relations-secrets': ['auth', 'relations-secrets'],
  'relations-readers': ['auth', 'relations', 'relations-readers'],
  'relations-archived': ['auth', 'relations', 'relations-archived'],
  'relations-not-pivot': ['auth', 'relations', 'relations-not-pivot'],
  // The DDL groups build on each other: the later ones alter, rename and drop what the first made.
  'ddl-columns': ['ddl/columns'],
  'ddl-indexes': ['ddl/columns', 'ddl/indexes'],
  ddl: ['ddl/columns', 'ddl/indexes', 'ddl/alter', 'ddl/rename', 'ddl/drop'],
  // Retiring leaves the column in the database, dropping it later takes it out.
  retired: ['retired-old', 'retired'],
  'retired-drop': ['retired-old', 'retired', 'retired-drop'],
  'known-columns': ['known-columns'],
  'known-columns-old': ['known-columns-old'],
  nullability: ['nullability'],
  'renamed-key': ['renamed-key'],
  'state-data': ['state-data'],
  'state-pause': ['state-pause'],
};
/** Directories loaded on Postgres only, next to their group (SQLite cannot do what they do). */
const PGSQL_ONLY: Record<string, string[]> = { markers: ['markers-pgsql'], nullability: ['nullability-pgsql'], ddl: ['ddl/alter-pgsql'] };
/** Directories no parity is asked of: they fail on purpose, write what the projection does not know, or are for the order a test runs them in. */
const EXCLUDED = ['bad-down', 'broken', 'order', 'order-independent', 'order-late', 'raw-add', 'raw-alter', 'raw-rename-column', 'raw-rename-table', 'raw-table', 'writes-record'];

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

/** Runs the migrations of `modules` on one fresh database — whatever connection they name — and compares the projection with what the database says. */
async function expectParity(driver: TestDriver, modules: ModuleDefinition[]): Promise<void> {
  const { connections, close } = await freshConnections(driver);
  try {
    const migrator = new Migrator({ modules, root: workspaceTempDir('marmeon-projection-') } as unknown as Application, connections);
    // One scratch database of every table: the plans run on `default`, as the types are generated for all connections at once.
    for (const file of migrator.files()) await runMigration(connections, await loadMigration(file));
    const projection = await migrator.projection();
    const run = catalog(connections);
    const real = await introspect(run, driver);
    const all = await tableColumns(run, driver);
    const mine = factsOf(projection, driver);
    const own = (name: string) => !isMigratorTable(name) && name !== 'sqlite_sequence';
    const tables = projection.tables;

    // Tables, columns and their order.
    expect([...all.types.keys()].filter(own).sort()).toEqual([...tables.keys()].sort());
    for (const [name, types] of all.types) {
      if (!own(name)) continue;
      const projected = tables.get(name)!;
      expect(projected.columns.map((c) => c.name), `columns of ${name}`).toEqual([...types.keys()]);
      // What the database has beyond the columns Marmeon knows is exactly what the migrations retired.
      expect(mine.columns.get(name), `known columns of ${name}`).toEqual(projected.columns.filter((c) => !c.retired).map((c) => c.name));
      for (const [column, type] of types) {
        expect(projected.columns.find((c) => c.name === column)!.nullable, `${name}.${column} nullable`).toBe(all.nullable.has(`${name}\0${column}`));
        if (projected.columns.find((c) => c.name === column)!.retired) continue;
        const declared = mine.types.get(name)!.get(column)!;
        expect(columnType(declared, driver), `${name}.${column}: ${declared} against ${type}`).toBe(columnType(type, driver));
        expect(kindOf(declared), `${name}.${column}`).toEqual(kindOf(type));
      }
    }
    // Keys and the relations' facts.
    // The database keeps the constraints of a retired column; Marmeon does not know them.
    const retired = (name: string, column: string) => tables.get(name)?.columns.find((c) => c.name === column)?.retired === true;
    expect(mine.foreignKeys).toEqual(real.foreignKeys.filter((key) => own(key.table) && !retired(key.table, key.column)));
    expect(Object.fromEntries(mine.uniques)).toEqual(
      Object.fromEntries(
        [...real.uniques]
          .filter(([name]) => own(name))
          .map(([name, sets]) => [name, sets.filter((set) => !set.some((column) => retired(name, column)))] as const),
      ),
    );
    expect(Object.fromEntries(mine.primaryKeys)).toEqual(Object.fromEntries([...real.primaryKeys].filter(([name]) => own(name))));
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

  // A database of its own, and every migration of the web app on it: on Postgres the longest work of the file.
  it('matches the database that the migrations of the web app migrate', { timeout: 30_000 }, async () => {
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
      const migrator = new Migrator({ modules: [fixtures('accounts')], root: workspaceTempDir('marmeon-projection-') } as unknown as Application, connections);
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

  it('are kept in .marmeon/schema.json of the app by the migrator, and read from it while the files fit', async () => {
    const root = workspaceTempDir('marmeon-projection-');
    const migrator = new Migrator({ modules: [fixtures('auth'), fixtures('blog')], root } as unknown as Application, undefined as never);
    const first = await migrator.projection();
    const written = readFileSync(join(root, PROJECTION_FILE), 'utf8');
    forgetProjections();

    expect(await migrator.projection()).toEqual(first);
    expect(readFileSync(join(root, PROJECTION_FILE), 'utf8')).toBe(written);
  });
});
