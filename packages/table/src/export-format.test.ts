import { afterEach, describe, expect, it } from 'vitest';
import { drivers, tableApp, type TableTestApp } from './__fixtures__/app.ts';
import { CSV_BOM, csvLine, unescapeCsvCell } from './csv.ts';
import { readCsv } from './csv-read.ts';
import { exportCsv } from './index.ts';

const ADA = 1; // an administrator
const ALAN = 2;

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The lines of an export, without the byte order mark. */
const linesOf = (text: string) => text.replace(CSV_BOM, '').split('\r\n').filter(Boolean);

describe('csvLine() with a delimiter', () => {
  it('joins the quoted cells with a comma, a semicolon or a tab — a comma without a choice', () => {
    expect(csvLine(['a', 1])).toBe('"a","1"\r\n');
    expect(csvLine(['a', 1], ';')).toBe('"a";"1"\r\n');
    expect(csvLine(['a', 1], '\t')).toBe('"a"\t"1"\r\n');
  });

  it('keeps every cell quoted and a formula escaped, whatever the delimiter', () => {
    for (const delimiter of [',', ';', '\t'] as const) {
      const line = csvLine(['=HYPERLINK("x")', `a${delimiter}b`, '-1+2', ' @SUM(1)', '\t=1', '-5'], delimiter);
      const read = readCsv(Buffer.from(line), { delimiter });
      expect(read.ok && read.value.headers, JSON.stringify(delimiter)).toEqual([`'=HYPERLINK("x")`, `a${delimiter}b`, "'-1+2", "' @SUM(1)", "'\t=1", '-5']);
    }
  });

  it.each([
    ['a pipe', '|'],
    ['a quote', '"'],
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a formula sign', '='],
    ['a minus', '-'],
    ['a space', ' '],
    ['two characters', ';;'],
    ['a full-width comma', '，'],
    ['an Arabic semicolon', '؛'],
    ['an empty text', ''],
    ['nothing', null],
    ['a number', 1],
  ])('refuses %s', (_name, delimiter) => {
    expect(() => csvLine(['a'], delimiter as never)).toThrow(TypeError);
  });
});

describe('what an export writes, readCsv reads back by itself', () => {
  it.each([',', ';', '\t'] as const)('detects %j without being told', (delimiter) => {
    const text = csvLine(['name', 'note', 'amount'], delimiter) + csvLine(['Ada', 'one, two; three\tfour', -5], delimiter) + csvLine(['=cmd', "it's", 2], delimiter);
    const read = readCsv(Buffer.from(CSV_BOM + text), { unescape: true });
    expect(read.ok && read.value.delimiter).toBe(delimiter);
    expect(read.ok && read.value.rows).toEqual([['Ada', 'one, two; three\tfour', '-5'], ['=cmd', "it's", '2']]);
    expect(unescapeCsvCell("'=cmd")).toBe('=cmd');
  });
});

describe('exportCsv().delimiter()', () => {
  it('takes a comma, a semicolon, a tab or a function — and keeps the choice through the other calls', () => {
    const choose = () => ';' as const;
    expect(exportCsv().separator).toBe(',');
    expect(exportCsv().delimiter(';').separator).toBe(';');
    expect(exportCsv().delimiter('\t').max(5).authorize(() => true).onExport(class { handle() {} }).separator).toBe('\t');
    expect(exportCsv().max(5).authorize(() => true).delimiter(choose).separator).toBe(choose);
  });

  it('refuses anything else when the table is defined', () => {
    for (const bad of ['|', '"', '\n', '\r', '=', ';;', '', ' ', null, 1]) {
      expect(() => exportCsv().delimiter(bad as never), JSON.stringify(bad)).toThrow(TypeError);
    }
    // @ts-expect-error a delimiter is one of three texts
    expect(() => exportCsv().delimiter('|' as string)).toThrow(TypeError);
  });
});

describe.each(drivers)('a delimiter and headings per request (%s)', (driver) => {
  const download = (application: TableTestApp, name: string, user: number, headers: Record<string, string> = {}, which = 'localized') =>
    application.request(`/teams/1/_tables/${which}/export/${name}`, { user, headers });

  it('writes the export with the separator of the table — default, semicolon or tab', async () => {
    open = await tableApp(driver);
    await open.connections.get().insertInto('ledger').values({ id: 1, note: 'a;b\tc,d', qty: 1, amount: '1.00', paid: true, booked_at: '2026-10-06T12:00:00.000Z', meta: '{}', formula: '=1+1' } as never).execute();
    for (const [name, delimiter] of [['csv', ','], ['semicolon', ';'], ['tab', '\t']] as const) {
      const response = await download(open, name, ADA, {}, 'ledger');
      expect(response.status, name).toBe(200);
      const lines = linesOf(await response.text());
      expect(lines[0], name).toBe(['"Note"', '"qty"', '"amount"', '"paid"', '"booked"', '"meta"', '"formula"'].join(delimiter));
      const read = readCsv(Buffer.from(lines.join('\r\n')), { unescape: true });
      expect(read.ok && read.value.delimiter, name).toBe(delimiter);
      expect(read.ok && read.value.rows[0]?.[0], 'a separator inside a cell split it').toBe('a;b\tc,d');
      expect(read.ok && read.value.rows[0]?.at(-1), 'a formula was not escaped').toBe('=1+1');
      expect(lines[1]).toContain(`"'=1+1"`);
    }
  });

  it('translates the headings and chooses the separator by the request: German with a semicolon, English with a comma', async () => {
    open = await tableApp(driver);
    const english = linesOf(await (await download(open, 'csv', ADA, { 'x-test-locale': 'en' })).text());
    expect(english[0]).toBe('"Name","Role","E-mail","bare"');
    const german = linesOf(await (await download(open, 'csv', ADA, { 'x-test-locale': 'de' })).text());
    // The translated heading is a formula: escaped like a cell.
    expect(german[0]).toBe(`"Name";"'=Rolle";"E-mail";"bare"`);
    expect(german[1]).toMatch(/^"Ada";"admin";/);
  });

  it('shows the same headings in the props, in the request\'s language', async () => {
    open = await tableApp(driver);
    const labels = async (locale: string) => {
      const page = (await (await open!.request('/teams/1/localized', { user: ADA, headers: { 'x-test-locale': locale } })).json()) as { localized: { columns: { name: string; label: string | null }[] } };
      return page.localized.columns.map((column) => column.label);
    };
    expect(await labels('en')).toEqual(['Name', 'Role', 'E-mail', null]);
    // The props carry the text as it is: the escape belongs to the file.
    expect(await labels('de')).toEqual(['Name', '=Rolle', 'E-mail', null]);
  });

  it('shows the key where no translator is bound, in the file and in the props', async () => {
    open = await tableApp(driver, { translator: false });
    const lines = linesOf(await (await download(open, 'csv', ADA)).text());
    expect(lines[0]).toBe('"columns.name","columns.role","E-mail","bare"');
    expect(lines[1]).toMatch(/^"Ada","admin",/);
    const page = (await (await open.request('/teams/1/localized', { user: ADA })).json()) as { localized: { columns: { label: string | null }[] } };
    expect(page.localized.columns.map((column) => column.label)).toEqual(['columns.name', 'columns.role', 'E-mail', null]);
  });

  it('asks the delimiter function with the request\'s own context', async () => {
    open = await tableApp(driver);
    expect(linesOf(await (await download(open, 'byUser', ADA)).text())[0]).toBe('"Name";"Role";"E-mail";"bare"');
    expect(linesOf(await (await download(open, 'byUser', ALAN)).text())[0]).toBe('"Name","Role","E-mail","bare"');
  });

  it('refuses an answer that is no delimiter before a byte: an error, no file', async () => {
    open = await tableApp(driver);
    const response = await download(open, 'wrong', ADA);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('Ada');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(open.recorder.exports, 'the refused export was recorded').toEqual([]);
  });
});
