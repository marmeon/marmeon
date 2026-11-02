import { afterEach, describe, expect, it } from 'vitest';
import { drivers, endpoint, ScopedTable, tableApp, type TableTestApp } from './__fixtures__/app.ts';

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const ADA = 1; // team 1
const MALLORY = 9; // team 2 — her row (id 9) is outside team 1's scope

describe.each(drivers)('a base query that resolves its scope from the container (%s)', (driver) => {
  const post = (application: TableTestApp, kind: 'action' | 'bulk', body: unknown) => application.request(endpoint(ScopedTable, kind, 'deactivate'), { method: 'POST', user: ADA, json: body });

  it('scopes the page: the rows and their total are the team\'s, another team\'s row is invisible', async () => {
    open = await tableApp(driver);
    const members = ((await (await open.request('/teams/1/scoped', { user: ADA })).json()) as { members: { rows: { id: number; name: string }[]; page: { total: number } } }).members;
    expect(members.rows.map((row) => row.name).sort()).toEqual(['Ada', 'Alan', 'Edsger', 'Grace']);
    expect(members.page.total).toBe(4);
    const hers = ((await (await open.request('/teams/2/scoped', { user: MALLORY })).json()) as { members: { rows: { name: string }[] } }).members;
    expect(hers.rows.map((row) => row.name)).toEqual(['Mallory']);
  });

  it('scopes a row action: a row of another team is a 404', async () => {
    open = await tableApp(driver);
    expect((await post(open, 'action', { key: 9 })).status).toBe(404);
    expect(open.recorder.deactivated).toEqual([]);
    expect((await post(open, 'action', { key: 2 })).status).toBe(200);
    expect(open.recorder.deactivated).toEqual([2]);
  });

  it('scopes a bulk action by keys and by "all matching"', async () => {
    open = await tableApp(driver);
    expect(await (await post(open, 'bulk', { keys: [2, 9] })).json()).toMatchObject({ done: 1, missing: 1 });
    expect(open.recorder.batches).toEqual([[2]]);
    const all = await post(open, 'bulk', { all: true, query: {} });
    expect(all.status).toBe(200);
    expect(open.recorder.batches.flat().sort(), 'the bulk action reached a row outside the scope').not.toContain(9);
    expect(open.recorder.batches.at(-1)!.sort()).toEqual([2, 4]); // team 1, minus the rows the policy refuses
  });

  it('scopes the export: the file and the count it records leave the other team out', async () => {
    open = await tableApp(driver);
    const text = await (await open.request(endpoint(ScopedTable, 'export', 'csv'), { user: ADA })).text();
    expect(text).toContain('"Ada"');
    expect(text, 'a row outside the scope was exported').not.toContain('Mallory');
    expect(open.recorder.exports[0]![0].rows).toBe(4);
  });

  it('resolves the scope when a filter.has() is checked against the base query, too', async () => {
    open = await tableApp(driver);
    const response = await open.request('/teams/1/scoped-teams', { user: ADA });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { teams: { rows: { name: string }[] } }).teams.rows.map((row) => row.name)).toEqual(['Team one']);
  });

  it('keeps exports() from building the base query', async () => {
    open = await tableApp(driver);
    const response = await open.request('/teams/1/scoped-links', { user: ADA });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { exports: unknown[] }).exports).toHaveLength(1);
    expect(open.recorder.scoped, 'exports() ran the base query').toBe(0);
  });
});
