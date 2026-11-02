import { Clock } from '@marmeon/core';
import { afterEach, describe, expect, it } from 'vitest';
import { drivers, endpoint, ExportsOnlyTable, guardedOverride, NamedTable, tableApp, type TableTestApp } from './__fixtures__/app.ts';
import type { TableExportEntry } from './index.ts';

let open: TableTestApp | undefined;
afterEach(async () => {
  guardedOverride.check = undefined;
  await open?.close();
  open = undefined;
});

const ADA = 1; // admin of team 1: sees the guarded table, exports
const ALAN = 2; // sees nothing guarded, may not export
const EDSGER = 4; // exports, not an admin

const disposition = async (application: TableTestApp, which: string, name?: string) => {
  const response = await application.request(endpoint(NamedTable, 'export', which), { user: ADA, headers: name === undefined ? {} : { 'x-test-name': encodeURIComponent(name) } });
  return { response, header: response.headers.get('content-disposition') };
};

/** The name in the plain `filename="…"` parameter. */
const fallbackOf = (header: string | null) => /filename="([^"]*)"/.exec(header ?? '')![1]!;
/** The real name, from `filename*=UTF-8''…`. */
const nameOf = (header: string | null) => decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(header ?? '')![1]!);

describe.each(drivers)('the name of an export (%s)', (driver) => {
  it('is what the export says, with .csv appended and the header encoded in both forms', async () => {
    open = await tableApp(driver);
    const { response, header } = await disposition(open, 'fixed');
    expect(response.status).toBe(200);
    expect(header).toBe(`attachment; filename="summer party.csv"; filename*=UTF-8''summer%20party.csv`);
    expect(nameOf((await disposition(open, 'given', 'Sommerfest für Gäste')).header)).toBe('Sommerfest für Gäste.csv');
  });

  it('takes a value of the route and the day of the app clock by resolve(Clock)', async () => {
    open = await tableApp(driver);
    open.application.container.instance(Clock, { now: () => Date.parse('2026-11-18T23:30:00Z') });
    const { header } = await disposition(open, 'day');
    expect(nameOf(header)).toBe('team-1-2026-11-18.csv');
  });

  it('cannot inject a header or a second parameter through the name', async () => {
    open = await tableApp(driver);
    const { response, header } = await disposition(open, 'given', 'Sommerfest "VIP"\r\nX-Evil: 1');
    expect(response.status).toBe(200);
    expect(header).not.toMatch(/[\r\n]/);
    expect(response.headers.get('x-evil')).toBeNull();
    // The quote cannot end the parameter early: the plain form has none inside.
    expect(fallbackOf(header)).toBe('Sommerfest _VIP_X-Evil: 1.csv');
    expect(nameOf(header)).toBe('Sommerfest "VIP"X-Evil: 1.csv');
  });

  it('leaves no path in the name', async () => {
    open = await tableApp(driver);
    expect(nameOf((await disposition(open, 'given', '../../etc/passwd')).header)).toBe('-..-etc-passwd.csv');
    expect(nameOf((await disposition(open, 'given', '..\\..\\windows\\system32')).header)).toBe('-..-windows-system32.csv');
    const { header } = await disposition(open, 'given', '/etc/passwd');
    expect(fallbackOf(header)).not.toContain('/');
    expect(nameOf(header)).not.toContain('/');
  });

  it('drops the characters that turn a name around, and keeps a double extension visible', async () => {
    open = await tableApp(driver);
    const flipped = await disposition(open, 'given', 'rechnung\u202Egpj');
    expect(nameOf(flipped.header)).toBe('rechnunggpj.csv');
    expect(flipped.header).not.toMatch(/%E2%80%AE/i);
    expect(nameOf((await disposition(open, 'given', 'a\u2066b\u2069c\u0085d\u007Fe\u0000f\u200Eg\u200Bh\u2060i\uFEFFj\u{E0041}k')).header)).toBe('abcdefghijk.csv');
    // `.csv` is always the last extension: a name that ends like a program stays one with `.csv` behind it.
    expect(nameOf((await disposition(open, 'given', 'invoice.exe')).header)).toBe('invoice.exe.csv');
  });

  it('trims dots and spaces at the ends', async () => {
    open = await tableApp(driver);
    expect(nameOf((await disposition(open, 'given', ' ..hidden. ')).header)).toBe('hidden.csv');
  });

  it('keeps at most 100 characters of the stem, whole code points', async () => {
    open = await tableApp(driver);
    expect(nameOf((await disposition(open, 'given', 'a'.repeat(300))).header)).toBe(`${'a'.repeat(100)}.csv`);
    const emoji = nameOf((await disposition(open, 'given', '😀'.repeat(300))).header);
    expect(emoji).toBe(`${'😀'.repeat(100)}.csv`);
    expect(emoji.isWellFormed()).toBe(true);
  });

  it('falls back to <table>-<day> when nothing is left', async () => {
    open = await tableApp(driver);
    open.application.container.instance(Clock, { now: () => Date.parse('2026-11-18T10:00:00Z') });
    for (const name of ['', ' . ', '\u202E\u0000', '...', '\u200B', '\u200B\u2060\uFEFF\u{E0041} .']) {
      expect(nameOf((await disposition(open, 'given', name)).header), JSON.stringify(name)).toBe('named-2026-11-18.csv');
    }
  });

  it('sends no file, and records nothing, when the function throws or answers no string', async () => {
    open = await tableApp(driver);
    const broken = await disposition(open, 'broken');
    expect(broken.response.status).toBe(500);
    expect(broken.header).toBeNull();
    expect(open.recorder.exports).toEqual([]);
    expect((await disposition(open, 'number')).response.status).toBe(500);
  });

  it('refuses a name that is neither a string nor a function when the export is defined', () => {
    expect(() => NamedTable.definition.exports.fixed!.filename(42 as never)).toThrow(TypeError);
  });
});

describe.each(drivers)('tables.exports() (%s)', (driver) => {
  const links = (application: TableTestApp, user: number | undefined, query = '', page = 'export-links') => application.request(`/teams/1/${page}${query}`, { user });
  const listed = async (application: TableTestApp, user: number, page = 'export-links') => ((await (await links(application, user, '', page)).json()) as { exports: TableExportEntry[] }).exports;

  it('gives the exports the user may use, with the address of the table in its default state', async () => {
    open = await tableApp(driver);
    expect(await listed(open, ADA)).toEqual([
      { name: 'open', format: 'csv', url: endpoint(ExportsOnlyTable, 'export', 'open'), max: 10_000 },
      { name: 'audit', format: 'csv', url: endpoint(ExportsOnlyTable, 'export', 'audit'), max: 50 },
      { name: 'admins', format: 'csv', url: endpoint(ExportsOnlyTable, 'export', 'admins'), max: 10_000 },
    ]);
  });

  it('leaves out the exports the user may not use: by policy, by check, for nobody', async () => {
    open = await tableApp(driver);
    expect((await listed(open, EDSGER)).map((entry) => entry.name)).toEqual(['open', 'audit']);
    expect((await listed(open, ALAN)).map((entry) => entry.name)).toEqual(['open']);
  });

  it('lists nothing that the download refuses, and the address it gives downloads the CSV', async () => {
    open = await tableApp(driver);
    for (const user of [ADA, ALAN, EDSGER]) {
      const entries = await listed(open, user);
      for (const name of ['open', 'audit', 'admins', 'nobody']) {
        const status = (await open.request(endpoint(ExportsOnlyTable, 'export', name), { user })).status;
        expect(entries.some((entry) => entry.name === name), `user ${user}, ${name}`).toBe(status === 200);
      }
    }
    const [first] = await listed(open, ADA);
    const file = await open.request(first!.url, { user: ADA });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await file.text()).toContain('"Ada"');
  });

  it('answers [] for a table the user may not see, and only for exactly true', async () => {
    open = await tableApp(driver);
    expect(await listed(open, ALAN, 'guarded-links')).toEqual([]);
    expect((await listed(open, ADA, 'guarded-links')).map((entry) => entry.name)).toEqual(['csv']);
    for (const answer of [1, 'yes', {}, undefined, null]) {
      guardedOverride.check = () => answer;
      expect(await listed(open, ADA, 'guarded-links'), JSON.stringify(answer)).toEqual([]);
    }
    guardedOverride.check = () => true;
    expect((await listed(open, ADA, 'guarded-links')).map((entry) => entry.name)).toEqual(['csv']);
  });

  it('runs no statement: not the base query, not a count', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    expect((await links(open, ADA)).status).toBe(200);
    expect(open.queries.map((query) => query.sql)).toEqual([]);
  });

  it('refuses a table that is not attached to the page, as resolve() does', async () => {
    open = await tableApp(driver);
    expect((await links(open, ADA, '?which=unattached')).status).toBe(500);
  });
});
