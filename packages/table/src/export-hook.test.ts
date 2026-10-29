import { afterEach, describe, expect, it } from 'vitest';
import { drivers, tableApp, type TableTestApp } from './__fixtures__/app.ts';
import { exportCsv } from './index.ts';

const ADA = 1; // admin of team 1: sees e-mails, exports
const ALAN = 2; // sees the table, may not export
const EDSGER = 4; // exports, sees no e-mails

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe.each(drivers)('exportCsv().onExport() (%s)', (driver) => {
  const download = (application: TableTestApp, user: number | undefined, query = '', which = 'csv') =>
    application.request(`/teams/1/_tables/audited/export/${which}${query ? `?${query}` : ''}`, { user });

  it('tells the recorder what was exported: the rows of the filtered query, the visible columns, the state, the route parameters', async () => {
    open = await tableApp(driver);
    const response = await download(open, EDSGER, 'sort=-name&filter[role]=member&search=a');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(open.recorder.exports).toEqual([
      [
        {
          table: 'audited',
          export: 'csv',
          rows: 2,
          columns: ['name'],
          state: { sort: { column: 'name', direction: 'desc' }, search: 'a', filters: { role: 'member' } },
        },
        { team: '1', tableExport: 'csv' },
      ],
    ]);
    // The count told is the number of rows the file holds.
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(1 + open.recorder.exports[0]![0].rows);
  });

  it('runs once for a file of many batches, and the columns follow who exports', async () => {
    open = await tableApp(driver);
    await open.insert(Array.from({ length: 1203 }, (_, index) => ({ id: 100 + index, team_id: 1, name: `Bulk ${index}`, email: `b${index}@example.com`, role: 'member', created_at: '2026-04-01 09:00:00' })));
    const text = await (await download(open, ADA)).text();
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(1208);
    expect(open.recorder.exports).toHaveLength(1);
    expect(open.recorder.exports[0]![0].rows).toBe(1207);
    expect(open.recorder.exports[0]![0].columns).toEqual(['name', 'email']);
  });

  it('is not called for an export that is refused: 401, 403, 404, 400, 422', async () => {
    open = await tableApp(driver);
    expect((await download(open, undefined)).status).toBe(401);
    expect((await download(open, ALAN)).status, 'the export ran without its authorization').toBe(403);
    expect((await download(open, ADA, '', 'missing')).status).toBe(404);
    expect((await open.request('/teams/2/_tables/audited/export/csv', { user: ADA })).status).toBe(404);
    expect((await download(open, ADA, 'sort=password')).status).toBe(400);
    expect((await download(open, EDSGER, 'sort=email')).status).toBe(400);
    expect((await download(open, ADA, 'filter[role]=owner')).status).toBe(400);
    expect((await download(open, ADA, '', 'small')).status, 'an export over its limit was streamed').toBe(422);
    expect(open.recorder.exports, 'a refused export was recorded').toEqual([]);
  });

  it('refuses the download when the recorder throws: an error, no file', async () => {
    open = await tableApp(driver);
    open.recorder.failExport = true;
    const response = await download(open, ADA);
    expect(response.status, 'the file was sent although it could not be recorded').toBe(500);
    const text = await response.text();
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('@example.com');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(open.recorder.exports).toEqual([]);
  });
});

describe('onExport(Recorder)', () => {
  it('takes a class with handle(info, ctx), and keeps the recorder through max() and authorize()', () => {
    class Good {
      handle() {}
    }
    class Bad {}
    // @ts-expect-error not a class with handle
    expect(() => exportCsv().onExport(Bad)).toThrow(TypeError);
    // @ts-expect-error a function is no class with handle
    expect(() => exportCsv().onExport(() => {})).toThrow(TypeError);
    expect(exportCsv().onExport(Good).max(5).authorize(() => true).recorder).toBe(Good);
    expect(exportCsv().max(5).authorize(() => true).onExport(Good).limit).toBe(5);
  });
});
