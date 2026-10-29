import { defineRoutes, Router } from '@marmeon/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drivers, endpointTrace, ProbedTable, tableApp, traced, type TableTestApp } from './__fixtures__/app.ts';
import { tableRoutes } from './index.ts';

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

describe.each(drivers)('tableRoutes() middleware per endpoint (%s)', (driver) => {
  const BASE = '/teams/1/_tables/probed';
  const act = (application: TableTestApp, user: number | undefined, headers: Record<string, string> = {}) =>
    application.request(`${BASE}/actions/deactivate`, { method: 'POST', user, json: { key: '4' }, headers });
  const bulk = (application: TableTestApp, user: number | undefined, headers: Record<string, string> = {}) =>
    application.request(`${BASE}/bulk/deactivate`, { method: 'POST', user, json: { keys: ['4'] }, headers });
  const download = (application: TableTestApp, user: number | undefined, headers: Record<string, string> = {}, base = BASE) =>
    application.request(`${base}/export/csv`, { user, headers });

  it('runs the registrar\'s middleware first, then the endpoint\'s in the order given', async () => {
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

  it('does not let an endpoint skip the registrar: a guest never reaches the endpoint middleware', async () => {
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
    const refused = await open.request(`${BASE}/actions/deactivate`, { ...grace, json: { key: '3' } });
    expect(refused.status).toBe(403);
    expect(endpointTrace).toContain('action');
    expect(open.recorder.deactivated).toEqual([]);
    expect(open.recorder.exports).toEqual([]);
    expect(open.recorder.deactivated).toEqual([]);
  });

  it('follows the kind of endpoint, not the path: a registration under /export gives its action nothing of the export\'s', async () => {
    open = await tableApp(driver);
    const under = '/teams/1/export/_tables/probed';
    expect((await act(open, ADA)).status).toBe(200);
    endpointTrace.length = 0;
    expect((await open.request(`${under}/actions/deactivate`, { method: 'POST', user: ADA, json: { key: '4' } })).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar']);
    endpointTrace.length = 0;
    expect((await download(open, ADA, {}, under)).status).toBe(200);
    expect(endpointTrace).toEqual(['registrar', 'export-first']);
  });
});

describe('tableRoutes() options', () => {
  const load = (options: unknown) => new Router().load(defineRoutes((Root) => tableRoutes(Root as never, ProbedTable as never, options as never)));

  it('loads with middleware per endpoint, or none', () => {
    expect(() => load(undefined)).not.toThrow();
    expect(() => load({ export: { middleware: [traced('one')] } })).not.toThrow();
  });

  it('refuses an option it does not know, naming the options', () => {
    expect(() => load({ exports: { middleware: [] } })).toThrow(/unknown option 'exports' — the options are export, bulk, action/);
  });

  it('refuses a middleware that is not a list, or not a middleware', () => {
    expect(() => load({ export: { middleware: traced('one') } })).toThrow(/options\.export\.middleware must be a list/);
    expect(() => load({ bulk: { middleware: ['throttle'] } })).toThrow(/middleware/);
  });
});
