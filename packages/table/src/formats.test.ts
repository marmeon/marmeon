import { Encrypter } from '@marmeon/encryption';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drivers, tableApp, type TableTestApp, type TestDriver } from './__fixtures__/app.ts';

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

describe.each(drivers)('frozen formats of the table package on %s', (driver) => {
  it('writes the CSV export byte for byte as the newest fixture of csv/ holds it — and names the file by the day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-06T08:00:00Z') });
    open = await tableApp(driver);
    await seed(open, driver);
    const response = await open.request('/teams/1/_tables/ledger/export/csv', { user: ADA });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="ledger-2026-10-06.csv"');
    const bytes = Buffer.from(await response.arrayBuffer());

    const directory = new URL('./__fixtures__/formats/csv/', import.meta.url);
    const names = readdirSync(directory).filter((name) => name.endsWith('.csv'));
    expect(names).toEqual(expect.arrayContaining(['v1.csv']));
    // The newest version is what the code writes; an older one stays in the directory, and keeps the form of its time.
    const newest = names.toSorted().at(-1)!;
    expect(bytes.toString('hex'), newest).toBe(readFileSync(new URL(newest, directory)).toString('hex'));
    for (const name of names) {
      const text = readFileSync(new URL(name, directory)).toString('utf8');
      expect(text.startsWith('﻿"Note","qty","amount","paid","booked","meta","formula"\r\n'), `${name}: BOM and the header`).toBe(true);
      expect(text.endsWith('\r\n'), `${name}: CRLF`).toBe(true);
    }
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
