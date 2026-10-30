import { defineRoutes, everyone, Router } from '@marmeon/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drivers, endpoint, endpointTrace, ProbedTable, tableApp, traced, type TableTestApp } from './__fixtures__/app.ts';

const ADA = 1; // admin of team 1: acts and exports
const ALAN = 2; // may not export

let open: TableTestApp | undefined;
beforeEach(() => {
  endpointTrace.length = 0;
});
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe.each(drivers)('endpoints() middleware per endpoint (%s)', (driver) => {
  const act = (application: TableTestApp, user: number | undefined, headers: Record<string, string> = {}) =>
    application.request(endpoint(ProbedTable, 'action', 'deactivate'), { method: 'POST', user, json: { key: '4' }, headers });
  const bulk = (application: TableTestApp, user: number | undefined, headers: Record<string, string> = {}) =>
    application.request(endpoint(ProbedTable, 'bulk', 'deactivate'), { method: 'POST', user, json: { keys: ['4'] }, headers });
  const download = (application: TableTestApp, user: number | undefined, headers: Record<string, string> = {}, url = endpoint(ProbedTable, 'export', 'csv')) =>
    application.request(url, { user, headers });

  it('runs the page\'s middleware first, then the endpoint\'s in the order given', async () => {
    open = await tableApp(driver);
    expect((await download(open, ADA)).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'export-first', 'export-second']);
    endpointTrace.length = 0;
    expect((await bulk(open, ADA)).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'bulk']);
    endpointTrace.length = 0;
    expect((await act(open, ADA)).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'action']);
  });

  it('applies to its own kind of endpoint only: a refused export leaves the action and the bulk action untouched', async () => {
    open = await tableApp(driver);
    expect((await download(open, ADA, { 'x-test-block': 'export-second' })).status).toBe(429);
    expect((await act(open, ADA, { 'x-test-block': 'export-second' })).status).toBe(200);
    expect((await bulk(open, ADA, { 'x-test-block': 'export-second' })).status).toBe(200);
    expect((await bulk(open, ADA, { 'x-test-block': 'bulk' })).status).toBe(429);
    expect((await act(open, ADA, { 'x-test-block': 'action' })).status).toBe(429);
  });

  it('stops an export before it counts a row, reads a batch or tells the recorder', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    const response = await download(open, ADA, { 'x-test-block': 'export-first' });
    expect(response.status).toBe(429);
    expect(open.queries).toEqual([]);
    expect(open.recorder.exports).toEqual([]);
    expect(endpointTrace).toEqual(['registrar', 'export-first']);
  });

  it('stops an action and a bulk action before they touch a row', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    expect((await act(open, ADA, { 'x-test-block': 'action' })).status).toBe(429);
    expect((await bulk(open, ADA, { 'x-test-block': 'bulk' })).status).toBe(429);
    expect(open.queries).toEqual([]);
    expect(open.recorder.deactivated).toEqual([]);
    expect(open.recorder.batches).toEqual([]);
  });

  it('stops the endpoint when its middleware throws', async () => {
    open = await tableApp(driver);
    expect((await act(open, ADA, { 'x-test-throw': 'action' })).status).toBe(500);
    expect((await bulk(open, ADA, { 'x-test-throw': 'bulk' })).status).toBe(500);
    expect((await download(open, ADA, { 'x-test-throw': 'export-second' })).status).toBe(500);
    expect(open.recorder.deactivated).toEqual([]);
    expect(open.recorder.batches).toEqual([]);
    expect(open.recorder.exports).toEqual([]);
  });

  it('does not let an endpoint skip the page\'s middleware: a guest never reaches the endpoint middleware', async () => {
    open = await tableApp(driver);
    expect((await download(open, undefined)).status).toBe(401);
    expect((await act(open, undefined)).status).toBe(401);
    expect(endpointTrace).toEqual([]);
  });

  it('does not let an endpoint skip the table\'s own authorize', async () => {
    open = await tableApp(driver);
    expect((await download(open, ALAN)).status).toBe(403);
    // Grace is protected by the policy: the action refuses her however the endpoint was reached.
    const grace = { method: 'POST', user: ADA };
    const refused = await open.request(endpoint(ProbedTable, 'action', 'deactivate'), { ...grace, json: { key: '3' } });
    expect(refused.status).toBe(403);
    expect(endpointTrace).toContain('action');
    expect(open.recorder.deactivated).toEqual([]);
    expect(open.recorder.exports).toEqual([]);
    expect(open.recorder.deactivated).toEqual([]);
  });

  it('follows the kind of endpoint, not the path: a page under /export gives its action nothing of the export\'s', async () => {
    open = await tableApp(driver);
    const under = (kind: string, name: string) => `/teams/1/export/_tables/probed/${kind}/${name}`;
    expect((await act(open, ADA)).status).toBe(200);
    endpointTrace.length = 0;
    // `all` is the middleware for every kind: after the page's, before the kind's.
    expect((await open.request(under('actions', 'deactivate'), { method: 'POST', user: ADA, json: { key: '4' } })).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'all']);
    endpointTrace.length = 0;
    expect((await open.request(under('bulk', 'deactivate'), { method: 'POST', user: ADA, json: { keys: ['4'] } })).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'all']);
    endpointTrace.length = 0;
    expect((await download(open, ADA, {}, under('export', 'csv'))).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'all', 'export-first']);
  });
});

describe('endpoints() options', () => {
  it('loads with middleware, per endpoint or for all, or none', () => {
    expect(() => ProbedTable.endpoints()).not.toThrow();
    expect(() => ProbedTable.endpoints({ export: { middleware: [traced('one')] } })).not.toThrow();
    expect(() => ProbedTable.endpoints({ middleware: [traced('one')] })).not.toThrow();
  });

  it('refuses an option it does not know, naming the options', () => {
    expect(() => ProbedTable.endpoints({ exports: { middleware: [] } } as never)).toThrow(/probed\.endpoints\(\): unknown option 'exports' — the options are middleware, export, bulk, action/);
  });

  it('refuses a middleware that is not a list, or not a middleware', () => {
    expect(() => ProbedTable.endpoints({ export: { middleware: traced('one') } } as never)).toThrow(/options\.export\.middleware must be a list/);
    expect(() => ProbedTable.endpoints({ middleware: traced('one') } as never)).toThrow(/options\.middleware must be a list/);
    const attach = () => new Router().load(defineRoutes((Root) => Root.authorize(everyone).get('/x', () => 'x').attach(ProbedTable.endpoints({ bulk: { middleware: ['throttle'] } } as never) as never)));
    expect(attach).toThrow(/middleware/);
  });

  it('refuses a kind given without a list of middleware', () => {
    for (const given of [{}, { middlware: [] }, null]) {
      expect(() => ProbedTable.endpoints({ export: given } as never)).toThrow(/options\.export\.middleware must be a list/);
    }
    expect(() => ProbedTable.endpoints({ middleware: 'x' } as never)).toThrow(/options\.middleware must be a list/);
  });

  it('gives a new, frozen object each time', () => {
    const first = ProbedTable.endpoints();
    expect(first).not.toBe(ProbedTable.endpoints());
    expect(Object.isFrozen(first)).toBe(true);
  });
});
