import { afterEach, describe, expect, it } from 'vitest';
import { column, defineTable, exportCsv, type TableContext } from './index.ts';
import { drivers, endpoint, FileColumnsTable, MEMBERS, tableApp, type TableTestApp } from './__fixtures__/app.ts';
import { CSV_BOM } from './csv.ts';

const ADA = 1; // an admin: sees e-mails and the last-seen column
const ALAN = 2; // sees neither

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const file = async (application: TableTestApp, user: number, name: string, query = '') => {
  const response = await application.request(`${endpoint(FileColumnsTable, 'export', name)}${query ? `?${query}` : ''}`, { user });
  return { response, lines: (await response.text()).replace(CSV_BOM, '').split('\r\n').filter(Boolean) };
};

describe('column().exportOnly()', () => {
  it('marks the column for the file', () => {
    expect(FileColumnsTable.definition.columns.active!.isExportOnly).toBe(true);
    expect(FileColumnsTable.definition.columns.name!.isExportOnly).toBe(false);
  });

  it('refuses sortable() and searchable() when the column is defined, in either order', () => {
    // @ts-expect-error -- a column only the file has cannot be sorted by
    expect(() => column('members.name').exportOnly().sortable()).toThrow(TypeError);
    // @ts-expect-error -- ... nor searched
    expect(() => column('members.name').exportOnly().searchable()).toThrow(TypeError);
    // @ts-expect-error -- a sortable column is on the page
    expect(() => column('members.name').sortable().exportOnly()).toThrow(TypeError);
    // @ts-expect-error -- a searchable column is on the page
    expect(() => column('members.name').searchable().exportOnly()).toThrow(TypeError);
  });

  it('keeps label() and visible() when chained after it', () => {
    const labelled = column('members.name').exportOnly().label('Full name');
    expect(labelled.isExportOnly).toBe(true);
    expect(labelled.text).toBe('Full name');
    expect(column('members.name').label('x').exportOnly().text).toBe('x');
  });
});

describe('exportCsv().columns()', () => {
  it('refuses an empty list, a doubled name and a name that is no text', () => {
    expect(() => exportCsv().columns([])).toThrow(TypeError);
    expect(() => exportCsv().columns(['name', 'name'])).toThrow(TypeError);
    expect(() => exportCsv().columns([1 as never])).toThrow(TypeError);
    expect(() => exportCsv().columns('name' as never)).toThrow(TypeError);
  });

  it('keeps the other settings, whichever order they come in', () => {
    const made = exportCsv().columns(['name']).max(5).delimiter(';');
    expect(made.chosen).toEqual(['name']);
    expect(made.limit).toBe(5);
    expect(exportCsv().max(5).columns(['name']).limit).toBe(5);
  });

  it('is checked against the table when it is defined: an unknown name is a TypeError', () => {
    expect(() =>
      defineTable({
        name: 'wrong-names',
        query: (db, _ctx: TableContext) => db.selectFrom('members'),
        key: 'id',
        columns: { name: column('name').sortable() },
        // @ts-expect-error -- 'emial' is no column of the table
        export: { csv: exportCsv().columns(['name', 'emial']) },
      }),
    ).toThrow(TypeError);
  });
});

describe.each(drivers)('an export that chooses its columns (%s)', (driver) => {
  it('leaves a column only the file has out of the page: props, columns and rows', async () => {
    open = await tableApp(driver);
    const body = (await (await open.request('/teams/1/file-columns', { user: ADA })).json()) as { table: { columns: { name: string }[]; rows: Record<string, unknown>[] } };
    expect(body.table.columns.map((entry) => entry.name)).toEqual(['name', 'email', 'role']);
    for (const row of body.table.rows) expect(Object.keys(row).sort()).toEqual(['can', 'email', 'id', 'name', 'role']);
  });

  it('does not select a column only the file has for the page', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    await open.request('/teams/1/file-columns', { user: ADA });
    for (const query of open.queries) expect(query.sql, 'the page selects a file column').not.toMatch(/last_seen_at|active/);
  });

  it('writes exactly the named columns, in that order — the label of an exportOnly column is its heading', async () => {
    open = await tableApp(driver);
    const { response, lines } = await file(open, ADA, 'chosen');
    expect(response.status).toBe(200);
    expect(lines[0]).toBe('"Active","name","email","seen"');
    expect(lines[1]).toMatch(/^"","Ada","ada@example\.com","2026-10-01/);
    expect(lines).toHaveLength(5);
  });

  it('writes every column the user sees, the file-only ones last, when it names none', async () => {
    open = await tableApp(driver);
    const { lines } = await file(open, ADA, 'all');
    expect(lines[0]).toBe('"name","email","role","Active","seen"');
    expect((await file(open, ALAN, 'all')).lines[0]).toBe('"name","role","Active"');
  });

  it('tells the recorder the columns of the file', async () => {
    open = await tableApp(driver);
    await file(open, ADA, 'chosen');
    await file(open, ALAN, 'chosen');
    expect(open.recorder.exports.map(([info]) => info.columns)).toEqual([['active', 'name', 'email', 'seen'], ['active', 'name']]);
  });

  it('leaves a named column the user may not see out of the file: head and cells', async () => {
    open = await tableApp(driver);
    const { response, lines } = await file(open, ALAN, 'chosen');
    expect(response.status).toBe(200);
    expect(lines[0], 'a hidden column reached the file').toBe('"Active","name"');
    expect(lines.join('\n'), 'a hidden column reached the file').not.toContain('@example.com');
    expect(lines.join('\n'), 'a hidden file-only column reached the file').not.toContain('2026-10-01');
  });

  it('refuses an export whose named columns are all hidden: 403 before any query or record, and no entry in the props or the list', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    const refused = await file(open, ALAN, 'admins');
    expect(refused.response.status).toBe(403);
    // A malformed state or a filter does not change the answer, and no option list is read first.
    open.queries.length = 0;
    expect((await file(open, ALAN, 'admins', 'filter[role]=nobody&sort=bogus')).response.status).toBe(403);
    expect(open.queries, 'a query ran for a refused export').toEqual([]);
    expect(open.queries, 'a query ran for a refused export').toEqual([]);
    expect(open.recorder.exports).toEqual([]);
    const page = (await (await open.request('/teams/1/file-columns', { user: ALAN })).json()) as { table: { exports: { name: string }[] }; listed: { name: string }[] };
    expect(page.table.exports.map((entry) => entry.name)).toEqual(['all', 'chosen']);
    expect(page.listed.map((entry) => entry.name)).toEqual(['all', 'chosen']);
    const admin = (await (await open.request('/teams/1/file-columns', { user: ADA })).json()) as typeof page;
    expect(admin.table.exports.map((entry) => entry.name)).toEqual(['all', 'chosen', 'admins']);
    expect(admin.listed.map((entry) => entry.name)).toEqual(['all', 'chosen', 'admins']);
    expect((await file(open, ADA, 'admins')).response.status).toBe(200);
  });

  it('does not select a hidden column, named or not', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    await file(open, ALAN, 'chosen');
    await file(open, ALAN, 'all');
    expect(open.queries.length).toBeGreaterThan(0);
    for (const query of open.queries) expect(query.sql, 'the SQL selects a hidden column').not.toMatch(/email|last_seen_at/);
  });

  it('refuses a sort by a column the user may not see, and by a column that is only in the file', async () => {
    open = await tableApp(driver);
    expect((await file(open, ALAN, 'chosen', 'sort=email')).response.status).toBe(400);
    expect((await file(open, ADA, 'chosen', 'sort=active')).response.status).toBe(400);
    expect((await file(open, ADA, 'chosen', 'sort=seen')).response.status).toBe(400);
  });

  it('sorts by a column the file does not hold, over a batch boundary — and does not write it', async () => {
    open = await tableApp(driver);
    const roles = ['owner', 'guest', 'editor'];
    const extra = Array.from({ length: 1203 }, (_, index) => ({ ...MEMBERS[1]!, id: 100 + index, name: `Bulk ${String(index).padStart(4, '0')}`, email: `b${index}@example.com`, role: roles[index % 3]! }));
    await open.insert(extra);
    const rows = [...MEMBERS.filter((member) => member.team_id === 1), ...extra];
    for (const [query, direction] of [['sort=role', 1], ['sort=-role', -1]] as const) {
      const { response, lines } = await file(open, ADA, 'chosen', query);
      expect(response.status, query).toBe(200);
      expect(lines[0]).toBe('"Active","name","email","seen"');
      const expected = rows.sort((a, b) => direction * a.role.localeCompare(b.role, 'en') || direction * (a.id - b.id)).map((member) => member.name);
      expect(lines.slice(1).map((line) => /^"[^"]*","([^"]*)"/.exec(line)![1]), query).toEqual(expected);
      expect(lines.join('\n'), 'the sort column was written').not.toContain('"guest"');
    }
  });
});
