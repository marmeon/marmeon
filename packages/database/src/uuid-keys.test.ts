import type { Application, ModuleDefinition } from '@marmeon/core';
import type { Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { Migrator, RecordNotFoundError, Repository, type Connections } from './index.ts';
import { runMigration } from './migrations/run.ts';

interface UuidTables {
  teams: { id: Generated<string>; name: string };
  members: { id: Generated<string>; team_id: string; name: string };
  profiles: { id: Generated<number>; public_id: Generated<string>; name: string };
}

class Teams extends Repository<'teams', UuidTables> {
  static table = 'teams' as const;
}
class Members extends Repository<'members', UuidTables> {
  static table = 'members' as const;
}
class Profiles extends Repository<'profiles', UuidTables> {
  static table = 'profiles' as const;
  static routeKey = 'public_id';
}

const modules: ModuleDefinition[] = [{ name: 'uuids', migrations: new URL('./__fixtures__/migrations/uuids/', import.meta.url) }];
const ctx = {} as never;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe.each(drivers)('Repositories with UUID keys on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let teams: Teams;
  let members: Members;
  let profiles: Profiles;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    teams = new Teams(connections);
    members = new Members(connections);
    profiles = new Profiles(connections);
  });
  afterAll(() => close());

  it('binds a UUID primary key, in either case, and finds nothing for what is no UUID', async () => {
    const team = await teams.insert({ name: 'Core' });
    expect(team.id).toMatch(V7);
    expect(await teams.resolveRouteBinding(team.id, { ctx })).toMatchObject({ name: 'Core' });
    expect(await teams.resolveRouteBinding(team.id.toUpperCase(), { ctx })).toMatchObject({ name: 'Core' });
    expect(await teams.findByRouteKey(team.id)).toMatchObject({ name: 'Core' });
    for (const value of ['not-a-uuid', '1', '', `${team.id}0`, "' or 1=1 --"]) {
      expect(await teams.resolveRouteBinding(value, { ctx })).toBeUndefined();
      expect(await teams.findByRouteKey(value)).toBeUndefined();
    }
  });

  it('binds the public key of a table whose primary key is an integer', async () => {
    const ada = await profiles.insert({ name: 'Ada' });
    expect(await profiles.resolveRouteBinding(ada.public_id, { ctx })).toMatchObject({ id: ada.id });
    expect(await profiles.resolveRouteBinding(ada.public_id.toUpperCase(), { ctx })).toMatchObject({ id: ada.id });
    expect(await profiles.findByRouteKey(ada.public_id)).toMatchObject({ id: ada.id });
    expect(await profiles.resolveRouteBinding(String(ada.id), { ctx })).toBeUndefined();
    expect(await profiles.findByRouteKey('not-a-uuid')).toBeUndefined();
  });

  it('keeps a scoped binding inside its parent', async () => {
    const core = await teams.insert({ name: 'Scope A' });
    const other = await teams.insert({ name: 'Scope B' });
    const member = await members.insert({ team_id: core.id, name: 'Ada' });
    expect(await members.resolveRouteBinding(member.id, { ctx, scope: { param: 'team', parent: core, column: 'team_id' } })).toMatchObject({ name: 'Ada' });
    expect(await members.resolveRouteBinding(member.id, { ctx, scope: { param: 'team', parent: other, column: 'team_id' } })).toBeUndefined();
  });

  it('answers find(), exists(), update(), delete() and friends with "not found" for an id that is no UUID — without a query', async () => {
    const team = await teams.insert({ name: 'Find' });
    expect(await teams.find(team.id)).toMatchObject({ name: 'Find' });
    expect(await teams.find(team.id.toUpperCase())).toMatchObject({ name: 'Find' });
    expect(await teams.exists(team.id)).toBe(true);

    const queries: string[] = [];
    connections.onQuery((query) => queries.push(query.sql));
    expect(await teams.find('x')).toBeUndefined();
    expect(await teams.exists('x')).toBe(false);
    expect(await teams.update('x', { name: 'No' })).toBeUndefined();
    expect(await teams.tryUpdate('x', { name: 'No' })).toMatchObject({ ok: false, error: { kind: 'missing' } });
    expect(await teams.delete('x')).toBe(false);
    expect(await teams.forceDelete('x')).toBe(false);
    expect(await teams.restore('x')).toBe(false);
    await expect(teams.findOrFail('x')).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect((teams as unknown as { relation(id: string, name: string): { create(values: object): Promise<unknown> } }).relation('x', 'members').create({ name: 'm' })).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(queries.filter((sql) => !/^(begin|commit|savepoint|release|rollback)/i.test(sql))).toEqual([]);
  });

  it('updates and deletes by UUID', async () => {
    const team = await teams.insert({ name: 'Old' });
    expect(await teams.update(team.id.toUpperCase(), { name: 'New' })).toMatchObject({ name: 'New' });
    expect(await teams.delete(team.id)).toBe(true);
    expect(await teams.find(team.id)).toBeUndefined();
  });
});

describe.each(drivers)('Adding a UUIDv7 column to an existing table on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await runMigration(connections, {
      up: (schema) =>
        schema.create('notes', (table) => {
          table.id();
          table.string('title');
        }),
    });
    for (const title of ['a', 'b', 'c']) await connections.get<any>().insertInto('notes').values({ title }).execute();
  });
  afterAll(() => close());

  const columnsOf = async () => (await connections.get<any>().introspection.getTables()).find((table) => table.name === 'notes')!.columns.map((c) => c.name);

  if (driver === 'sqlite') {
    it('is refused before anything changes', async () => {
      const before = await columnsOf();
      await expect(
        runMigration(connections, {
          up: (schema) => {
            // The refusal covers the whole plan: nothing before the offending step runs either.
            schema.alter('notes', (table) => table.string('title2').nullable());
            schema.alter('notes', (table) => {
              table.string('subtitle').nullable();
              table.uuid('public_id').unique().useUuidv7();
            });
          },
        }),
      ).rejects.toThrow(/schema\.alter\('notes'\) cannot add the UUIDv7 column "public_id" on SQLite.*docs\/migrations\.md#uuid-keys/);
      expect(await columnsOf()).toEqual(before);
    });
  } else {
    it('gives every existing row its own UUIDv7, and new rows too', async () => {
      const db = connections.get<any>();
      await runMigration(connections, {
        up: (schema) =>
          schema.alter('notes', (table) => {
            table.uuid('public_id').unique().useUuidv7();
          }),
      });
      const ids = (await db.selectFrom('notes').select('public_id').execute()).map((row: { public_id: string }) => row.public_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(id).toMatch(V7);
      await db.insertInto('notes').values({ title: 'd' }).execute();
      expect((await db.selectFrom('notes').select('public_id').where('title', '=', 'd').executeTakeFirstOrThrow()).public_id).toMatch(V7);
    });
  }
});
