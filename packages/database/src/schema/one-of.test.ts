import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections, type TestDriver } from '../__fixtures__/databases.ts';
import type { Connections } from '../connections.ts';
import { runMigration } from '../migrations/run.ts';
import { renderTypes } from '../types-gen/render.ts';
import { applyPlan, emptyProjection, type ProjectedTable, type SchemaProjection } from './projection.ts';
import { planOf } from './plan.ts';
import type { Schema } from './schema.ts';

type Up = (schema: Schema) => void;

const project = (...ups: Up[]): SchemaProjection =>
  ups.reduce((projection, up, i) => applyPlan(projection, planOf({ up }, 'up'), { name: `m${i}`, module: 'app' }), emptyProjection);
const table = (projection: SchemaProjection, name: string): ProjectedTable => projection.tables.get(name)!;

const create: Up = (schema) =>
  schema.create('memberships', (t) => {
    t.id();
    t.string('role').oneOf('admin', 'member').default('member');
    t.string('state').nullable().oneOf('open', 'closed');
    t.integer('seats').default(1);
    t.check('memberships_seats_check', 'seats > 0');
  });

describe.each(drivers)('oneOf() and check() on %s', (driver: TestDriver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeEach(async () => ({ connections, close } = await freshConnections(driver)));
  afterEach(() => close());

  const insert = (values: Record<string, unknown>) => connections.get<any>().insertInto('memberships').values(values).execute();

  it('holds a column to its list, and lets NULL pass in a nullable one', async () => {
    await runMigration(connections, { up: create });
    await insert({ role: 'admin', state: 'open' });
    await insert({ role: 'member', state: null });
    await expect(insert({ role: 'owner' })).rejects.toThrow(/memberships_role_check|CHECK constraint/i);
    await expect(insert({ role: 'admin', state: 'gone' })).rejects.toThrow(/memberships_state_check|CHECK constraint/i);
  });

  it('holds a table to a named check()', async () => {
    await runMigration(connections, { up: create });
    await expect(insert({ role: 'admin', seats: 0 })).rejects.toThrow(/memberships_seats_check|CHECK constraint/i);
  });

  it('writes values with a quote or an injection attempt as plain text', async () => {
    const odd = ["o'brien", "x'); drop table memberships; --", "'", 'ünï €'];
    await runMigration(connections, { up: (schema) => schema.create('memberships', (t) => { t.id(); t.string('role').oneOf(...odd); }) });
    for (const role of odd) await insert({ role });
    await expect(insert({ role: "o''brien" })).rejects.toThrow(/memberships_role_check|CHECK constraint/i);
    await expect(insert({ role: 'x' })).rejects.toThrow(/memberships_role_check|CHECK constraint/i);
    expect((await connections.get<any>().selectFrom('memberships').select('role').execute()).map((row) => row.role).sort()).toEqual([...odd].sort());
  });

  it('adds a oneOf() column to an existing table, and refuses a row it does not fit', async () => {
    await runMigration(connections, { up: (schema) => schema.create('memberships', (t) => { t.id(); t.string('name').default('x'); }) });
    await insert({ name: 'a' });
    await runMigration(connections, { up: (schema) => schema.alter('memberships', (t) => t.string('role').oneOf('admin', 'member').default('member')) });
    await insert({ role: 'admin' });
    await expect(insert({ role: 'owner' })).rejects.toThrow(/memberships_role_check|CHECK constraint/i);
  });

  it('changes a constraint with dropCheck() and check() on Postgres, and refuses it on SQLite before any step', async () => {
    await runMigration(connections, { up: create });
    const change = runMigration(connections, {
      up: (schema) => {
        schema.create('other', (t) => t.id());
        schema.alter('memberships', (t) => {
          t.dropCheck('memberships_role_check');
          t.check('memberships_role_check', "role in ('admin', 'member', 'owner')");
        });
      },
    });
    if (driver === 'sqlite') {
      await expect(change).rejects.toThrow(/D18.*cannot use check\('memberships_role_check', …\) on SQLite.*docs\/migrations\.md#check-constraints/s);
      expect((await connections.get<any>().introspection.getTables()).map((t: { name: string }) => t.name)).not.toContain('other');
      await expect(runMigration(connections, { up: (schema) => schema.alter('memberships', (t) => t.check('c', 'seats > 1')) })).rejects.toThrow(/D18.*cannot use check\('c', …\)/s);
    } else {
      await change;
      await insert({ role: 'owner' });
      await expect(insert({ role: 'guest' })).rejects.toThrow(/memberships_role_check/);
    }
  });

  it.runIf(driver === 'pgsql')('renames the constraint with the table when indexes are renamed, and the projection follows', async () => {
    await runMigration(connections, { up: create });
    await runMigration(connections, { up: (schema) => schema.rename('memberships', 'seats', { indexes: true }) });
    await runMigration(connections, { up: (schema) => schema.alter('seats', (t) => { t.dropCheck('seats_role_check'); t.dropCheck('seats_seats_check'); }) });
    await connections.get<any>().insertInto('seats').values({ role: 'owner' }).execute();
  });

  it('refuses a constraint name that Postgres would cut', async () => {
    const name = 'x'.repeat(64);
    const run = runMigration(connections, { up: (schema) => schema.create('memberships', (t) => { t.id(); t.check(name, 'id > 0'); }) });
    if (driver === 'pgsql') await expect(run).rejects.toThrow(/D5.*check constraint name/s);
    else await run;
  });
});

describe('oneOf() and check() as the blueprint takes them', () => {
  const column = (build: (t: Parameters<Parameters<Schema['create']>[1]>[0]) => void) => () => planOf({ up: (schema) => schema.create('t', (t) => { t.id(); build(t); }) }, 'up');

  it.each([
    ['no value', () => column((t) => t.string('a').oneOf())(), /needs at least one value/],
    ['an empty value', () => column((t) => t.string('a').oneOf(''))(), /1 to 255 characters/],
    ['a value of 256 characters', () => column((t) => t.string('a').oneOf('x'.repeat(256)))(), /1 to 255 characters/],
    ['a NUL character', () => column((t) => t.string('a').oneOf('a\0b'))(), /NUL/],
    ['a value twice', () => column((t) => t.string('a').oneOf('a', 'a'))(), /lists a value twice/],
    ['a backslash', () => column((t) => t.string('a').oneOf('a\\b'))(), /backslash/],
    ['a column that is no string', () => column((t) => t.json('a').oneOf('a'))(), /string\(\) or text\(\) column only/],
    ['two calls', // @ts-expect-error — the second list does not fit the first
    () => column((t) => t.string('a').oneOf('a').oneOf('b'))(), /called twice/],
    ['a check without a condition', () => column((t) => t.check('c', ' '))(), /needs a name and a condition/],
  ])('refuses %s', (_, run, message) => {
    expect(run).toThrow(message);
  });

  it('refuses dropCheck() in create()', () => {
    expect(() => planOf({ up: (schema) => schema.create('t', (t) => { t.id(); t.dropCheck('c'); }) }, 'up')).toThrow(/only work when changing a table/);
  });
});

describe('what the projection says of a list and a check', () => {
  it('knows the values, and says nothing of them for a table without', () => {
    const projection = project(create, (schema) => schema.create('plain', (t) => { t.id(); t.string('name'); }));
    const memberships = table(projection, 'memberships');
    expect(memberships.columns.find((c) => c.name === 'role')).toMatchObject({ values: ['admin', 'member'], valuesCheck: 'memberships_role_check' });
    expect(memberships.checks).toEqual([{ name: 'memberships_seats_check', sql: 'seats > 0' }]);
    expect(JSON.stringify(table(projection, 'plain'))).not.toMatch(/values|checks/);
  });

  it('forgets a list and a check that dropCheck() drops, also after the column is renamed', () => {
    const projection = project(create, (schema) =>
      schema.alter('memberships', (t) => {
        t.renameColumn('role', 'kind');
        t.dropCheck('memberships_role_check');
        t.dropCheck('memberships_seats_check');
      }),
    );
    const memberships = table(projection, 'memberships');
    expect(memberships.columns.find((c) => c.name === 'kind')).not.toHaveProperty('values');
    expect(memberships).not.toHaveProperty('checks');
  });

  it('follows a table rename with indexes: true, and keeps the names without', () => {
    const renamed = project(create, (schema) => schema.rename('memberships', 'seats', { indexes: true }));
    expect(table(renamed, 'seats').columns.find((c) => c.name === 'role')?.valuesCheck).toBe('seats_role_check');
    expect(table(renamed, 'seats').checks?.[0]?.name).toBe('seats_seats_check');
    const kept = project(create, (schema) => schema.rename('memberships', 'seats'));
    expect(table(kept, 'seats').columns.find((c) => c.name === 'role')?.valuesCheck).toBe('memberships_role_check');
    expect(() => project(create, (schema) => schema.rename('memberships', 'seats', { indexes: true }), (schema) => schema.alter('seats', (t) => t.dropCheck('seats_role_check')))).not.toThrow();
  });

  it('refuses a check name used twice before anything runs', () => {
    const twice = (build: (t: Parameters<Parameters<Schema['create']>[1]>[0]) => void) => () =>
      project((schema) => schema.create('t', (t) => { t.id(); t.string('x'); build(t); }));
    expect(twice((t) => { t.string('y').oneOf('a'); t.check('t_y_check', 'true'); })).toThrow(/D19.*t_y_check/s);
    expect(twice((t) => { t.check('c', 'true'); t.check('c', 'true'); })).toThrow(/D19.*"c"/s);
    expect(() => project(create, (schema) => schema.alter('memberships', (t) => t.string('seats_x').oneOf('a')), (schema) => schema.alter('memberships', (t) => t.check('memberships_seats_x_check', 'true')))).toThrow(/D19/);
    expect(() => project((schema) => schema.create('t', (t) => { t.id(); t.check('t_x_check', 'true'); }), (schema) => schema.alter('t', (t) => t.string('x').oneOf('a')))).toThrow(/D19.*t_x_check/s);
  });

  it('refuses to drop a check nobody added, and a name used twice', () => {
    expect(() => project(create, (schema) => schema.alter('memberships', (t) => t.dropCheck('nope')))).toThrow(/D19.*check constraint "nope"/s);
    expect(() => project(create, (schema) => schema.alter('memberships', (t) => t.check('memberships_role_check', 'true')))).toThrow(/D19.*of that name/s);
  });

  it('changes a list with dropCheck() and check(), and keeps the list of an added column', () => {
    const projection = project(create, (schema) => schema.alter('memberships', (t) => { t.dropCheck('memberships_role_check'); t.string('tier').oneOf('a'); }));
    const memberships = table(projection, 'memberships');
    expect(memberships.columns.find((c) => c.name === 'role')).not.toHaveProperty('values');
    expect(memberships.columns.find((c) => c.name === 'tier')?.values).toEqual(['a']);
  });
});

describe('the type of a column held to a list', () => {
  const render = (projection: SchemaProjection) => renderTypes({ driver: 'sqlite', projection, modules: ['app'], exposes: new Map() }).source;

  it('is the union of the values, with null for a nullable column', () => {
    const source = render(project(create));
    expect(source).toContain("role: Generated<'admin' | 'member'>;");
    expect(source).toContain("state: 'open' | 'closed' | null;");
  });

  it('writes a value with a quote or a line break as a valid literal', () => {
    const source = render(project((schema) => schema.create('t', (t) => { t.id(); t.string('a').oneOf("it's", 'x\ny'); })));
    expect(source).toContain(`a: 'it\\'s' | "x\\ny";`);
  });
});
