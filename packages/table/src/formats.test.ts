import { Clock } from '@marmeon/core';
import { Encrypter } from '@marmeon/encryption';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCsv } from './csv-read.ts';
import { drivers, endpoint, LedgerTable, tableApp, type TableTestApp, type TestDriver } from './__fixtures__/app.ts';

let open: TableTestApp | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await open?.close();
  open = undefined;
});

const ADA = 1;

/** The ledger: text with a quote and a line break, an integer, a negative decimal (text), a boolean, a time, JSON, a formula. */
async function seed(application: TableTestApp, driver: TestDriver): Promise<void> {
  const meta = (value: unknown) => (driver === 'pgsql' ? value : JSON.stringify(value));
  await application.connections
    .get()
    .insertInto('ledger')
    .values([
      { id: 1, note: 'Say "hi",\nthere', qty: 3, amount: '-12.50', paid: true, booked_at: '2026-10-06T12:00:00.000Z', meta: meta({ a: 1, list: ['x', null] }), formula: '=HYPERLINK("http://evil.example","x")' },
      { id: 2, note: 'Zoë', qty: -7, amount: '1234.00', paid: false, booked_at: '2026-01-02T03:04:05.000Z', meta: meta({}), formula: "-1+cmd|' /C calc'!A0" },
    ] as never)
    .execute();
}

/** Fixtures of an export's choice on the same data: the export's key in the ledger table, the file, its delimiter. */
const CASES = [
  ['semicolon', 'v1-semicolon.csv', ';'],
  ['tab', 'v1-tab.csv', '\t'],
] as const;

describe.each(drivers)('frozen formats of the table package on %s', (driver) => {
  it("names the export by the UTC day of the app's Clock, not of the machine — also just before midnight", async () => {
    open = await tableApp(driver);
    let now = Date.parse('2026-11-18T23:30:00Z');
    open.application.container.instance(Clock, { now: () => now });
    const name = async () => (await open!.request(endpoint(LedgerTable, 'export', 'csv'), { user: ADA })).headers.get('content-disposition');
    expect(await name()).toBe('attachment; filename="ledger-2026-11-18.csv"');
    now = Date.parse('2026-11-19T00:00:01Z');
    expect(await name()).toBe('attachment; filename="ledger-2026-11-19.csv"');
  });

  it('writes the CSV export byte for byte as the newest fixture of csv/ holds it — and names the file by the day', async () => {
    open = await tableApp(driver);
    open.application.container.instance(Clock, { now: () => Date.parse('2026-10-06T08:00:00Z') });
    await seed(open, driver);
    const response = await open.request(endpoint(LedgerTable, 'export', 'csv'), { user: ADA });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="ledger-2026-10-06.csv"');
    const bytes = Buffer.from(await response.arrayBuffer());

    const directory = new URL('./__fixtures__/formats/csv/', import.meta.url);
    // `v<N>.csv`: the default export. A file of another name shows a choice of the export (its delimiter) on the same data.
    const names = readdirSync(directory).filter((name) => /^v\d+\.csv$/.test(name));
    expect(names).toEqual(expect.arrayContaining(['v1.csv']));
    // The newest version is what the code writes; an older one stays in the directory, and keeps the form of its time.
    const newest = names.toSorted().at(-1)!;
    expect(bytes.toString('hex'), newest).toBe(readFileSync(new URL(newest, directory)).toString('hex'));
    // Every file is either a version of the default export or a case below: nothing in the directory goes unchecked.
    expect(readdirSync(directory).toSorted()).toEqual([...names, ...CASES.map(([, name]) => name)].toSorted());
    for (const name of names) {
      const text = readFileSync(new URL(name, directory)).toString('utf8');
      expect(text.startsWith('﻿"Note","qty","amount","paid","booked","meta","formula"\r\n'), `${name}: BOM and the header`).toBe(true);
      expect(text.endsWith('\r\n'), `${name}: CRLF`).toBe(true);
    }
  });

  it.each(CASES)('writes the %s export byte for byte as its fixture holds it — the same cells as the default, one separator in their place', async (which, name, delimiter) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-06T08:00:00Z') });
    open = await tableApp(driver);
    await seed(open, driver);
    const bytes = Buffer.from(await (await open.request(endpoint(LedgerTable, 'export', which), { user: ADA })).arrayBuffer());
    const directory = new URL('./__fixtures__/formats/csv/', import.meta.url);
    expect(bytes.toString('hex'), name).toBe(readFileSync(new URL(name, directory)).toString('hex'));
    // Only the separator differs: read back with the delimiter, the cells are the default export's.
    const read = readCsv(bytes, { delimiter: delimiter as ';' });
    const base = readCsv(readFileSync(new URL('v1.csv', directory)), { delimiter: ',' });
    if (!read.ok || !base.ok) throw new Error('a fixture did not read');
    expect({ headers: read.value.headers, rows: read.value.rows }, name).toEqual({ headers: base.value.headers, rows: base.value.rows });
  });

  it('opens every cursor fixture: the context it is sealed under and the payload of the feed table', async () => {
    open = await tableApp(driver);
    const directory = new URL('./__fixtures__/formats/cursor/', import.meta.url);
    const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(names).toEqual(expect.arrayContaining(['v1.json']));
    for (const name of names) {
      const fixture = JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as { context: string; payload: string };
      // Hands back the payload only for the context the fixture was sealed under, as the real one does.
      const sealed = {
        encrypt: async (plaintext: string, context: string) => `${context}|${plaintext}`,
        decrypt: async (_cursor: string, context: string) => {
          if (context !== fixture.context) throw new Error('The payload is invalid.');
          return fixture.payload;
        },
      };
      open.application.container.instance(Encrypter, sealed as unknown as Encrypter);
      // What the code seals today is the fixture again; what the fixture holds still opens the next page.
      const first = (await (await open.request('/teams/1/feed', { user: ADA })).json()) as { feed: { page: { nextCursor: string } } };
      // The payload holds the row's time as the driver returns it: Postgres writes it in ISO form.
      const payload = driver === 'sqlite' ? fixture.payload : '["2026-10-01T10:00:00.000Z",1]';
      expect(first.feed.page.nextCursor, name).toBe(`${fixture.context}|${payload}`);
      const second = (await (await open.request('/teams/1/feed?feed_cursor=sealed', { user: ADA })).json()) as { feed: { rows: { name: string }[] } };
      expect(second.feed.rows.map((row) => row.name), name).toEqual(['Edsger', 'Alan']);
    }
  });
});
