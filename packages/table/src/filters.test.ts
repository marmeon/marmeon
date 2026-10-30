import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drivers, endpoint, filterOptions, TeamFilterTable, tableApp, USERS, type TableTestApp, type TestDriver } from './__fixtures__/app.ts';
import { Database } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { column, defineTable, filter, type DataTable } from './define.ts';
import { pageOf } from './test-helpers/attached-page.ts';
import { DataTables } from './tables.ts';
import type { TableData } from './client/index.ts';

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});
beforeEach(() => {
  filterOptions.calls = 0;
  filterOptions.params = [];
});

async function app(driver: TestDriver): Promise<TableTestApp> {
  open = await tableApp(driver);
  return open;
}

const ADA = 1; // admin of team 1
const ALAN = 2; // member of team 1
const EDSGER = 4; // refused by the table's authorize
const MALLORY = 9; // team 2

type Teams = TableData<{ id: number; name: string }>;

async function teams(application: TableTestApp, user: number, query = '', team = user === MALLORY ? 2 : 1): Promise<{ status: number; teams: Teams; text: string }> {
  const response = await application.request(`/teams/${team}/team-filter${query ? `?${query}` : ''}`, { user });
  const text = await response.text();
  return { status: response.status, teams: response.status === 200 ? (JSON.parse(text) as { teams: Teams }).teams : (undefined as never), text };
}
const names = (table: Teams) => table.rows.map((row) => row.name);
const selectsFromTeams = (application: TableTestApp) => application.queries.filter((query) => /from "teams"/.test(query.sql));

describe.each(drivers)('filters by a relation and by options per request on %s', (driver) => {
  describe('filter.has()', () => {
    it('keeps the rows that have a related row with the value — an option of the list, bound as a parameter', async () => {
      const application = await app(driver);
      expect(names((await teams(application, ADA)).teams)).toEqual(['Team one', 'Team two']);
      expect(names((await teams(application, ADA, 'filter[ada]=Mallory')).teams)).toEqual(['Team two']);
      expect(names((await teams(application, ADA, 'filter[ada]=Ada')).teams)).toEqual(['Team one']);
      expect(names((await teams(application, ADA, 'filter[role]=admin')).teams)).toEqual(['Team one', 'Team two']);
      // Together with another filter: one more AND, never an OR.
      expect(names((await teams(application, ADA, 'filter[ada]=Ada&filter[member]=Alan')).teams)).toEqual(['Team one']);
      expect((await teams(application, ADA, 'filter[ada]=Mallory&filter[member]=Alan')).teams.rows).toEqual([]);
    });

    it('offers its options as { value, label } and the value in use', async () => {
      const application = await app(driver);
      const { teams: table } = await teams(application, ADA, 'filter[member]=Alan');
      const member = table.filters.find((entry) => entry.name === 'member')!;
      expect(member).toEqual({
        name: 'member',
        type: 'has',
        key: 'filter[member]',
        options: ['Ada', 'Alan', 'Edsger', 'Grace'],
        labels: ['Member Ada', 'Member Alan', 'Member Edsger', 'Member Grace'],
        value: 'Alan',
      });
      expect(table.filters.find((entry) => entry.name === 'ada')).toMatchObject({ type: 'has', options: ['Ada', 'Mallory'], labels: ['Ada', 'Mallory'], value: null });
    });

    it('sends the options as values and labels only: whatever else an option carries stays on the server', async () => {
      const application = await app(driver);
      const { teams: table, text } = await teams(application, ADA);
      expect(Object.keys(table.filters.find((entry) => entry.name === 'member')!).sort()).toEqual(['key', 'labels', 'name', 'options', 'type', 'value']);
      expect(text, 'a field of an option reached the props').not.toMatch(/ada@example\.com|team_id/);
    });

    it('refuses a value outside the request\'s options before the table is read: the other team\'s member is a 400 and no oracle', async () => {
      const application = await app(driver);
      application.queries.length = 0;
      const foreign = await teams(application, ADA, 'filter[member]=Mallory');
      expect(foreign.status, 'a member of another team was accepted as an option').toBe(400);
      expect(foreign.text).not.toContain('Mallory');
      expect(selectsFromTeams(application), 'the table was read for a value outside the options').toEqual([]);
      // The same value is an option for the team it belongs to — and the other team's member is none there.
      expect(names((await teams(application, MALLORY, 'filter[member]=Mallory')).teams)).toEqual(['Team two']);
      expect((await teams(application, MALLORY, 'filter[member]=Ada')).status).toBe(400);
    });

    it('refuses what is not an option, however it is written: a number, SQL, a case, an empty value, a list', async () => {
      const application = await app(driver);
      for (const query of ['filter[member]=1', "filter[member]=Ada' or '1'='1", 'filter[member]=ada', 'filter[member]=', 'filter[member]=Ada&filter[member]=Alan', 'filter[member][]=Ada']) {
        expect((await teams(application, ADA, query)).status, query).toBe(400);
      }
      // A static list is checked as before.
      expect((await teams(application, ADA, 'filter[ada]=Alan')).status).toBe(400);
    });

    it('is no way to another relation, column or filter: only what the table declared', async () => {
      const application = await app(driver);
      for (const query of ['filter[members]=Ada', 'filter[name]=Team one', 'filter[members.name]=Ada', 'filter[password]=x']) {
        expect((await teams(application, ADA, query)).status, query).toBe(400);
      }
    });

    it('honours .visible(): a hidden has filter is no filter for whoever may not see it', async () => {
      const application = await app(driver);
      expect((await teams(application, ALAN, 'filter[hidden]=Ada')).status).toBe(400);
      expect((await teams(application, ALAN)).teams.filters.map((entry) => entry.name)).toEqual(['member', 'ada', 'role']);
      expect((await teams(application, ADA, 'filter[hidden]=Ada')).status).toBe(200);
    });
  });

  describe('checked against the schema', () => {
    const request = (query = '') => ({ request: new Request(`http://localhost/teams/1/x${query}`), query: { per_page: 25, page: 1 }, user: USERS[ADA], team: 1 });
    const resolveOn = (tables: DataTables, table: DataTable, query = '') => tables.resolve(table, { ...request(query), route: pageOf(table) } as never);
    const tableOf = (filters: Record<string, unknown>, from = 'teams') =>
      defineTable({ name: 'x', query: (db: Database) => (db as any).selectFrom(from), key: `${from}.id`, columns: { name: column(`${from}.name`) }, filters } as never);

    it('refuses a relation the query\'s table does not have, or a column the related table lacks, on the first request — whatever the URL carries', async () => {
      const application = await app(driver);
      const tables = application.application.container.createScope().make(DataTables);
      await expect(resolveOn(tables, tableOf({ x: filter.has('nope' as never, ['a'] as never) }))).rejects.toThrow(/the filter 'x' .* needs a relation 'nope' of teams/);
      await expect(resolveOn(tables, tableOf({ x: filter.has('members', ['a'], { column: 'nope' } as never) }))).rejects.toThrow(/members\.nope, which is no column of members/);
    });

    it('refuses a secret column of the related table', async () => {
      const application = await app(driver);
      await runMigration(application.connections, {
        up: (schema) =>
          schema.create('vaults', (table) => {
            table.id();
            table.foreignId('team_id').constrained();
            table.string('token').secret();
          }),
      });
      // The fixture's connection reads the catalog (it is not managed), which knows no secret mark: the metadata of a managed
      // connection leaves a secret column out of `columns`, so that is what the check is given.
      const real = application.connections.metadata();
      const metadata = {
        get fresh() {
          return real.fresh;
        },
        relations: { get: (table: string) => real.relations.get(table) },
        columns: { get: (table: string) => (table === 'vaults' ? real.columns.get(table)?.filter((name) => name !== 'token') : real.columns.get(table)) },
      };
      const scope = application.application.container.createScope();
      const unused = () => {
        throw new Error('not needed');
      };
      const tables = new DataTables(scope.make(Database), unused, (Class) => scope.make(Class), unused, () => metadata);
      await expect(resolveOn(tables, tableOf({ x: filter.has('vaults', ['a'], { column: 'token' } as never) }))).rejects.toThrow(/vaults\.token, which is no column of vaults \(or a secret one\)/);
      // A column that is not secret goes through.
      await expect(resolveOn(tables, tableOf({ x: filter.has('vaults', ['1'], { column: 'team_id' }) }))).resolves.toBeDefined();
    });

    it('compares the related table\'s column, named with its table — never a column of the outer row', async () => {
      const application = await app(driver);
      application.queries.length = 0;
      await teams(application, ADA, 'filter[ada]=Ada');
      const has = application.queries.filter((query) => /exists/i.test(query.sql));
      expect(has.length).toBeGreaterThan(0);
      for (const query of has) expect(query.sql).toMatch(/"members"\."name"\s*=/);
    });

    it('compares a text value with an integer key by the default column id, on either database', async () => {
      const application = await app(driver);
      const tables = application.application.container.createScope().make(DataTables);
      const members = tableOf({ team: filter.has('team', ['1', '2']) }, 'members');
      const props = (await resolveOn(tables, members, '?filter%5Bteam%5D=2')) as unknown as Teams;
      expect(props.rows.map((row) => row.name)).toEqual(['Mallory']);
      await expect(resolveOn(tables, members, '?filter%5Bteam%5D=3')).rejects.toThrow(/one of its options/);
    });
  });

  describe('options per request', () => {
    it('are computed once per request, with the request\'s ctx — after the table\'s authorize, and not for a request that is refused', async () => {
      const application = await app(driver);
      await teams(application, ADA);
      expect(filterOptions.calls).toBe(1);
      expect(filterOptions.params).toEqual(['1']);
      filterOptions.calls = 0;
      expect((await teams(application, EDSGER)).status).toBe(403);
      expect((await teams(application, ADA, 'filter[nothing]=x')).status).toBe(400);
      expect((await teams(application, ADA, 'sort=password')).status).toBe(400);
      expect(filterOptions.calls, 'options were computed for a request that was refused').toBe(0);
    });

    it('a select filter takes the options of its request: an administrator may choose admin, a member may not', async () => {
      const application = await app(driver);
      const asAdmin = await application.request('/teams/1/role-options?filter[role]=admin', { user: ADA });
      expect(asAdmin.status).toBe(200);
      const table = ((await asAdmin.json()) as { members: TableData<{ name: string }> }).members;
      expect(table.rows.map((row) => row.name)).toEqual(['Ada']);
      expect(table.filters).toEqual([
        { name: 'role', type: 'select', key: 'filter[role]', options: ['admin', 'member'], labels: ['Administrators', 'member'], value: 'admin' },
      ]);
      const asMember = await application.request('/teams/1/role-options?filter[role]=admin', { user: ALAN });
      expect(asMember.status, 'a member filtered by an option only administrators get').toBe(400);
      expect((await application.request('/teams/1/role-options?filter[role]=member', { user: ALAN })).status).toBe(200);
    });

    it('a dynamic has filter takes the options of its request as well', async () => {
      const application = await app(driver);
      expect((await teams(application, ALAN, 'filter[role]=admin')).status, 'a member filtered by an option only administrators get').toBe(400);
      expect(names((await teams(application, ALAN, 'filter[role]=member')).teams)).toEqual(['Team one']);
    });
  });

  describe('exports and "all matching"', () => {
    const csv = (application: TableTestApp, user: number, query: string) => application.request(`${endpoint(TeamFilterTable, 'export', 'csv')}?${query}`, { user });
    const touch = (application: TableTestApp, user: number, query: Record<string, string>) =>
      application.request(endpoint(TeamFilterTable, 'bulk', 'touch'), { method: 'POST', user, json: { all: true, query } });

    it('an export is narrowed by the filter and refuses a value outside the options', async () => {
      const application = await app(driver);
      const lines = (await (await csv(application, ADA, 'filter[ada]=Mallory')).text()).split('\r\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('Team two');
      const foreign = await csv(application, ADA, 'filter[member]=Mallory');
      expect(foreign.status, 'an export took a value outside the options').toBe(400);
    });

    it('"all matching" acts on the filtered rows only, and refuses a value outside the options before it acts', async () => {
      const application = await app(driver);
      const done = await touch(application, ADA, { 'filter[ada]': 'Mallory' });
      expect(done.status).toBe(200);
      expect(application.recorder.batches).toEqual([[2]]);
      application.recorder.batches.length = 0;
      expect((await touch(application, ADA, { 'filter[member]': 'Mallory' })).status, 'a bulk action took a value outside the options').toBe(400);
      expect(application.recorder.batches).toEqual([]);
    });

    it('the filters of the export URL carry through the props', async () => {
      const application = await app(driver);
      const { teams: table } = await teams(application, ADA, 'filter[member]=Ada');
      expect(table.state).toEqual({ 'filter[member]': 'Ada' });
      expect(table.exports[0]!.url).toBe(`${endpoint(TeamFilterTable, 'export', 'csv')}?filter%5Bmember%5D=Ada`);
    });
  });
});

describe('the definition', () => {
  it('checks what a filter is declared with', () => {
    expect(() => filter.has('members.name' as never, ['a'])).toThrow(/a relation/);
    expect(() => filter.has('members', [] as never)).toThrow(/one or more options/);
    expect(() => filter.has('members', ['a'], { column: 'name; drop table x' })).toThrow(/column/);
    expect(() => filter.select('role', [{ value: 'a' }] as never)).toThrow(/strings/);
    expect(() => filter.has('members', ['a'], { column: 'x.y' } as never)).toThrow(/column/);
    expect(() => filter.select('role', [''] as never)).toThrow(/1 to 100/);
  });
});
