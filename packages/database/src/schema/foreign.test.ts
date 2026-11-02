import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections, type TestDriver } from '../__fixtures__/databases.ts';
import type { Connections } from '../connections.ts';
import { runMigration } from '../migrations/run.ts';
import { deriveRelations } from '../introspection.ts';
import { renderTypes } from '../types-gen/render.ts';
import { planOf } from './plan.ts';
import { applyPlan, emptyProjection, factsOf, type SchemaProjection } from './projection.ts';
import type { Schema } from './schema.ts';

type Up = (schema: Schema) => void;

const project = (...ups: Up[]): SchemaProjection =>
  ups.reduce((projection, up, i) => applyPlan(projection, planOf({ up }, 'up'), { name: `m${i}`, module: 'app' }), emptyProjection);

const create: Up = (schema) => {
  schema.create('forms', (t) => {
    t.id();
    t.string('title');
  });
  schema.create('guest_categories', (t) => {
    t.id();
    t.integer('form_id').nullable();
    t.string('name');
  });
};

describe.each(drivers)('foreign() on %s', (driver: TestDriver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeEach(async () => ({ connections, close } = await freshConnections(driver)));
  afterEach(() => close());

  const db = () => connections.get<any>();
  const tableNames = async () => (await db().introspection.getTables()).map((t: { name: string }) => t.name);

  it.runIf(driver === 'sqlite')('refuses the plan on SQLite before its first step, with the way around it', async () => {
    await runMigration(connections, { up: create });
    const change = runMigration(connections, {
      up: (schema) => {
        schema.create('other', (t) => t.id());
        schema.alter('guest_categories', (t) => t.foreign('form_id').constrained('forms').nullOnDelete());
      },
    });
    await expect(change).rejects.toThrow(/D18.*cannot use foreign\('form_id'\) on SQLite.*new column.*docs\/migrations\.md#a-reference-that-comes-later/s);
    expect(await tableNames()).not.toContain('other');
  });

  it.runIf(driver === 'pgsql')('gives an existing column its reference, with the action on delete', async () => {
    await runMigration(connections, { up: create });
    await db().insertInto('forms').values({ title: 'a' }).execute();
    await db().insertInto('guest_categories').values({ form_id: 1, name: 'before' }).execute();
    await runMigration(connections, { up: (schema) => schema.alter('guest_categories', (t) => t.foreign('form_id').constrained().nullOnDelete()) });
    await expect(db().insertInto('guest_categories').values({ form_id: 99, name: 'x' }).execute()).rejects.toThrow(/guest_categories_form_id_fkey/);
    await db().deleteFrom('forms').where('id', '=', 1).execute();
    expect((await db().selectFrom('guest_categories').select('form_id').execute())[0]!.form_id).toBeNull();
  });

  it.runIf(driver === 'pgsql')('fails the migration when a row has no match, and changes nothing', async () => {
    await runMigration(connections, { up: create });
    await db().insertInto('guest_categories').values({ form_id: 7, name: 'orphan' }).execute();
    const change = runMigration(connections, {
      up: (schema) => {
        schema.create('other', (t) => t.id());
        schema.alter('guest_categories', (t) => t.foreign('form_id').constrained('forms'));
      },
    });
    await expect(change).rejects.toThrow(/guest_categories_form_id_fkey/);
    expect(await tableNames()).not.toContain('other');
  });

  // The migrator folds every plan into the projection before it runs the first statement; runMigration() does not, so the test does.
  it('refuses an unknown column, a column of another kind and a missing table from the projection, before any statement', async () => {
    await runMigration(connections, { up: create });
    const refuse = (build: (t: Parameters<Parameters<Schema['alter']>[1]>[0]) => void) =>
      applyPlan(connections.projection(), planOf({ up: (schema) => schema.alter('guest_categories', build) }, 'up'), { name: 'tie', module: 'app' });
    expect(() => refuse((t) => t.foreign('nope').constrained('forms'))).toThrow(/D19/);
    expect(() => refuse((t) => t.foreign('form_id').constrained('nowhere'))).toThrow(/D19.*nowhere/s);
    expect(() => refuse((t) => t.foreign('name').constrained('forms'))).toThrow(/D19.*different kinds/s);
    expect(() => refuse((t) => { t.foreign('form_id').constrained('forms'); t.dropColumn('form_id'); })).toThrow(/D19.*drops the column/s);
    expect(() => refuse((t) => { t.foreign('form_id').constrained('forms'); t.retire('form_id'); })).toThrow(/D19.*retires the column/s);
    expect(() => refuse((t) => t.foreign('form_id').constrained('forms'))).not.toThrow();
  });
});

describe.each(drivers)('a foreign key name on %s', (driver: TestDriver) => {
  it.runIf(driver === 'pgsql')('refuses a name Postgres would cut, with a hint that fits', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      const long = 'x'.repeat(40);
      await runMigration(connections, { up: (schema) => { schema.create('targets', (t) => t.id()); schema.create(`${long}_table`, (t) => { t.id(); t.bigInteger(`${long}_id`); }); } });
      const run = runMigration(connections, { up: (schema) => schema.alter(`${long}_table`, (t) => t.foreign(`${long}_id`).constrained('targets')) });
      await expect(run).rejects.toThrow(/D5.*foreign key name.*shorter table or column name/s);
    } finally {
      await close();
    }
  });
});

describe('what the blueprint takes for foreign()', () => {
  it('refuses foreign() in create(), a call twice and one without constrained()', () => {
    expect(() => planOf({ up: (schema) => schema.create('t', (t) => { t.id(); t.integer('a'); t.foreign('a').constrained('x'); }) }, 'up')).toThrow(/use foreignId\(…\)\.constrained\(\) in create\(\)/);
    expect(() => planOf({ up: (schema) => schema.alter('t', (t) => { t.foreign('a').constrained('x'); t.foreign('a').constrained('x'); }) }, 'up')).toThrow(/called twice/);
    expect(() => planOf({ up: (schema) => schema.alter('t', (t) => { t.foreign('a'); }) }, 'up')).toThrow(/needs constrained\(\)/);
    expect(() => planOf({ up: (schema) => schema.alter('t', (t) => { t.foreign('a').constrained('x').inverse('Bad Name'); }) }, 'up')).toThrow(/snake_case/);
  });

  it('refuses a change after up() returned', () => {
    let late!: () => unknown;
    planOf({ up: (schema) => schema.alter('t', (t) => { late = () => t.foreign('b'); const key = t.foreign('a').constrained('x'); const again = () => key.nullOnDelete(); late = again; }) }, 'up');
    expect(late).toThrow(/plan of this migration is closed/);
  });
});

describe('what the projection says of foreign()', () => {
  const tie: Up = (schema) => schema.alter('guest_categories', (t) => t.foreign('form_id').constrained().nullOnDelete().inverse('categories'));
  const render = (projection: SchemaProjection) => renderTypes({ driver: 'pgsql', projection, modules: ['app'], exposes: new Map(), relations: deriveRelations(factsOf(projection, 'pgsql')).relations }).source;

  it('holds the key like one from constrained(), and db:types knows the relation', () => {
    expect(render(project(create))).not.toContain('belongsTo');
    const projection = project(create, tie);
    expect(projection.tables.get('guest_categories')!.foreignKeys).toEqual([{ column: 'form_id', references: 'forms', referenced: 'id', onDelete: 'set null', inverse: 'categories' }]);
    const source = render(projection);
    const relations = source.slice(source.indexOf('  interface Relations {'), source.indexOf('  interface PrimaryKeys {'));
    expect(relations).toContain("form: { kind: 'belongsTo'; table: 'forms'; foreignKey: 'form_id'");
    expect(relations).toContain("categories: { kind: 'hasMany'; table: 'guest_categories'");
  });

  it('refuses what cannot hold, with D19', () => {
    const alter = (build: (t: Parameters<Parameters<Schema['alter']>[1]>[0]) => void): Up => (schema) => schema.alter('guest_categories', build);
    expect(() => project(create, alter((t) => t.foreign('nope').constrained('forms')))).toThrow(/D19.*nope/s);
    expect(() => project(create, alter((t) => t.foreign('form_id').constrained('nowhere')))).toThrow(/D19.*nowhere/s);
    expect(() => project(create, alter((t) => t.foreign('form_id').constrained('forms', 'title')))).toThrow(/D19.*different kinds/s);
    expect(() => project(create, alter((t) => t.foreign('form_id').constrained('forms', 'nope')))).toThrow(/D19.*nope/s);
    expect(() => project(create, tie, tie)).toThrow(/D19.*holds it already/s);
    expect(() => project((schema) => { create(schema); schema.alter('guest_categories', (t) => t.foreignId('owner_id').constrained('forms')); }, alter((t) => t.foreign('owner_id').constrained('forms')))).toThrow(/D19.*holds it already/s);
    expect(() => project(create, (schema) => schema.alter('forms', (t) => t.retire('title')), alter((t) => t.foreign('form_id').constrained('forms', 'title')))).toThrow(/D19/);
  });

  it('ties a column to a table of the same plan, and drops the key with its column', () => {
    const projection = project(
      (schema) => { schema.create('forms', (t) => t.id()); schema.create('guest_categories', (t) => { t.id(); t.bigInteger('form_id').nullable(); }); schema.alter('guest_categories', (t) => t.foreign('form_id').constrained()); },
      (schema) => schema.alter('guest_categories', (t) => t.dropColumn('form_id')),
    );
    expect(projection.tables.get('guest_categories')!.foreignKeys).toEqual([]);
  });
});
