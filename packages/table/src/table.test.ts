import { afterEach, describe, expect, it } from 'vitest';
import { drivers, MEMBERS, MembersTable, tableApp, USERS, type TableTestApp, type TestDriver } from './__fixtures__/app.ts';
import { Tables } from './tables.ts';
import type { TableData } from './client/index.ts';

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function app(driver: TestDriver): Promise<TableTestApp> {
  open = await tableApp(driver);
  return open;
}

const ADA = 1; // admin of team 1: sees e-mails, manages, exports
const ALAN = 2; // member of team 1
const EDSGER = 4; // exports, but does not see e-mails
const MALLORY = 9; // team 2

type Members = TableData<{ id: number; name: string; email?: string; role: string; joined: string; seen: string | null }>;

async function page(application: TableTestApp, user: number, query = '', path = '/teams/1/members'): Promise<{ status: number; members: Members; text: string }> {
  const response = await application.request(`${path}${query ? `?${query}` : ''}`, { user });
  const text = await response.text();
  return { status: response.status, members: response.status === 200 ? (JSON.parse(text) as { members: Members }).members : (undefined as never), text };
}

const names = (members: Members) => members.rows.map((row) => row.name);

describe.each(drivers)('@marmeon/table on %s', (driver) => {
  describe('the page prop (resolve)', () => {
    it('sends the visible columns only — a hidden one has no entry, no value in any row, no word in the response', async () => {
      const application = await app(driver);
      const admin = await page(application, ADA, 'per_page=10');
      expect(admin.members.columns.map((column) => column.name)).toEqual(['name', 'email', 'role', 'joined', 'seen']);
      expect(admin.members.rows.map((row) => row.email)).toEqual(['ada@example.com', 'alan@example.com', 'edsger@example.com', 'grace@example.com']);

      const member = await page(application, ALAN, 'per_page=10');
      expect(member.members.columns.map((column) => column.name)).toEqual(['name', 'role', 'joined', 'seen']);
      expect(member.members.rows.every((row) => !Object.hasOwn(row, 'email'))).toBe(true);
      expect(member.text).not.toContain('@example.com');
      expect(Object.keys(member.members.rows[0]!).sort()).toEqual(['can', 'id', 'joined', 'name', 'role', 'seen']);
    });

    it('does not select a hidden column — the SQL has visible columns and the key only (the projection)', async () => {
      const application = await app(driver);
      await page(application, ALAN);
      const selects = application.queries.map((query) => query.sql).filter((text) => /\bfrom\b/i.test(text) && /members/.test(text));
      expect(selects.length).toBeGreaterThan(0);
      for (const text of selects) expect(text, 'the SQL selects a hidden column').not.toMatch(/email/);
      application.queries.length = 0;
      await page(application, ADA);
      expect(application.queries.some((query) => /"members"\."email" as "email"/.test(query.sql))).toBe(true);
    });

    it('keeps whatever the base query selects itself on the server — only the visible columns reach the props (the props filter)', async () => {
      const application = await app(driver);
      const response = await application.request('/teams/1/leaky', { user: ALAN });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text, 'a hidden column reached the props').not.toContain('@example.com');
      const { leaky } = JSON.parse(text) as { leaky: Members };
      expect(leaky.rows.map((row) => Object.keys(row).sort())).toEqual(leaky.rows.map(() => ['can', 'id', 'name']));
      expect(text).not.toContain('@example.com');
    });

    it('stays within the base query — the tenant (another team\'s members never show)', async () => {
      const application = await app(driver);
      const { members } = await page(application, ADA, 'per_page=10');
      expect(names(members)).toEqual(['Ada', 'Alan', 'Edsger', 'Grace']);
      expect((await page(application, MALLORY, 'per_page=10', '/teams/2/members')).members.rows.map((row) => row.id)).toEqual([9]);
    });

    it('sorts by an alias, both ways, the key breaking ties — and NULLs last either way, on every database', async () => {
      const application = await app(driver);
      expect(names((await page(application, ALAN, 'per_page=10&sort=-joined')).members)).toEqual(['Edsger', 'Grace', 'Alan', 'Ada']);
      expect(names((await page(application, ALAN, 'per_page=10&sort=seen')).members)).toEqual(['Ada', 'Grace', 'Alan', 'Edsger']);
      expect(names((await page(application, ALAN, 'per_page=10&sort=-seen')).members)).toEqual(['Grace', 'Ada', 'Edsger', 'Alan']);
      const sorted = await page(application, ALAN, 'per_page=10&sort=-joined');
      expect(sorted.members.sort).toEqual({ column: 'joined', direction: 'desc' });
      expect(sorted.members.columns.find((column) => column.name === 'joined')!.sort).toBe('desc');
      expect(sorted.members.columns.filter((column) => column.sort !== null)).toHaveLength(1);
      expect(sorted.members.state).toEqual({ sort: '-joined' });
    });

    it('filters by an allowlisted filter and searches the visible searchable columns — wildcards taken literally', async () => {
      const application = await app(driver);
      expect(names((await page(application, ALAN, 'per_page=10&filter[role]=admin')).members)).toEqual(['Ada']);
      expect(names((await page(application, ALAN, 'per_page=10&filter[joined]=2026-02-01..2026-03-10')).members)).toEqual(['Alan', 'Grace']);
      expect(names((await page(application, ALAN, 'per_page=10&filter[joined]=2026-03-11..')).members)).toEqual(['Edsger']);
      expect(names((await page(application, ALAN, 'per_page=10&search=  AL ')).members)).toEqual(['Alan']);
      expect(names((await page(application, ALAN, 'per_page=10&search=%25')).members)).toEqual([]);
      // E-mail is searchable — but only where it is visible: Alan cannot find Grace by her address, Ada can.
      expect(names((await page(application, ALAN, 'per_page=10&search=grace@')).members)).toEqual([]);
      expect(names((await page(application, ADA, 'per_page=10&search=grace@')).members)).toEqual(['Grace']);
      const filtered = await page(application, ALAN, 'filter[role]=member&search=a');
      expect(filtered.members.filters).toEqual([
        { name: 'role', type: 'select', key: 'filter[role]', options: ['admin', 'member'], value: 'member' },
        { name: 'joined', type: 'dateRange', key: 'filter[joined]', value: null },
      ]);
      expect(filtered.members.search).toEqual({ value: 'a' });
    });

    it('pages by number with a total — the sizes from the definition', async () => {
      const application = await app(driver);
      const first = await page(application, ALAN);
      expect(first.members.page).toEqual({ type: 'offset', page: 1, perPage: 2, perPageOptions: [2, 10], total: 4, lastPage: 2, from: 1, to: 2 });
      expect(names(first.members)).toEqual(['Ada', 'Alan']);
      expect(names((await page(application, ALAN, 'page=2')).members)).toEqual(['Edsger', 'Grace']);
      expect(first.members.query).toEqual({ sort: 'sort', page: 'page', perPage: 'per_page', cursor: 'cursor', search: 'search' });
    });

    it('says per row which actions the policy allows (booleans, one projection per policy) — and offers actions only to who may see them', async () => {
      const application = await app(driver);
      const admin = (await page(application, ADA, 'per_page=10')).members;
      expect(admin.rows.map((row) => [row.name, row.can])).toEqual([
        ['Ada', { deactivate: false }], // not yourself
        ['Alan', { deactivate: true }],
        ['Edsger', { deactivate: true }],
        ['Grace', { deactivate: false }], // protected
      ]);
      expect(admin.actions).toEqual([{ name: 'deactivate', url: '/teams/1/_tables/members/actions/deactivate', confirm: true }]);
      expect(admin.bulk).toEqual([{ name: 'deactivate', url: '/teams/1/_tables/members/bulk/deactivate', confirm: false, max: 5 }]);
      expect(admin.exports).toEqual([{ name: 'csv', format: 'csv', url: '/teams/1/_tables/members/export/csv', max: 10_000 }]);
      const member = (await page(application, ALAN, 'per_page=10&sort=-joined&filter[role]=member')).members;
      expect(member.actions).toEqual([]);
      expect(member.bulk).toEqual([]);
      expect(member.exports).toEqual([]);
      expect(member.rows.every((row) => JSON.stringify(row.can) === '{}')).toBe(true);
      const exporter = (await page(application, EDSGER, 'per_page=10&sort=-joined&filter[role]=member')).members;
      expect(exporter.exports).toEqual([{ name: 'csv', format: 'csv', url: '/teams/1/_tables/members/export/csv?sort=-joined&filter%5Brole%5D=member', max: 10_000 }]);
    });

    it('pages by an encrypted cursor when asked to — a changed cursor is a 400', async () => {
      const application = await app(driver);
      const feed = async (query = '') => {
        const response = await application.request(`/teams/1/feed${query ? `?${query}` : ''}`, { user: ALAN });
        return { status: response.status, feed: response.status === 200 ? ((await response.json()) as { feed: Members }).feed : undefined };
      };
      const first = (await feed()).feed!;
      expect(names(first)).toEqual(['Grace', 'Ada']);
      expect(first.page).toMatchObject({ type: 'cursor', perPage: 2 });
      expect(first.query.cursor).toBe('feed_cursor');
      const cursor = (first.page as { nextCursor: string }).nextCursor;
      // A plain cursor would be the row's values as JSON (`["Ada",1]`); quotes are outside the ciphertext's alphabet — a bare `Ada` is not
      // (it turned up at random in an encrypted cursor once).
      expect(cursor, 'the cursor holds the row in plain text').not.toContain('"Ada"');
      const second = (await feed(`feed_cursor=${encodeURIComponent(cursor)}`)).feed!;
      expect(names(second)).toEqual(['Edsger', 'Alan']);
      expect((await feed(`feed_cursor=${encodeURIComponent(`${cursor.slice(0, -4)}AAAA`)}`)).status, 'a changed cursor was taken').toBe(400);
      expect((await feed('feed_cursor=bm90LWEtY3Vyc29y')).status).toBe(400);
      // The table's keys carry its prefix: an unprefixed `page` is the page's business, a prefixed one the table's (a cursor table has none).
      expect((await feed('feed_page=2')).status).toBe(400);
      // Another table with the same order and keys takes none of this one's cursors (W10 step 8: the cursor's context names the table).
      const copy = await application.request(`/teams/1/feed-copy?feed_cursor=${encodeURIComponent(cursor)}`, { user: ALAN });
      expect(copy.status, "another table's cursor was taken").toBe(400);
      expect((await application.request('/teams/1/feed-copy', { user: ALAN })).status).toBe(200);
    });
  });

  describe('the URL is parsed strictly (E183): what the table does not allow is a 400 — never a quiet default', () => {
    it.each([
      ['an unknown sort', 'sort=unknown'],
      ['a raw column name', 'sort=password'],
      ['a column name instead of its alias', 'sort=created_at'],
      ['a filter that is none', 'filter[password]=x'],
      ['a filter value that is none', 'filter[role]=root'],
      ['a broken date range', 'filter[joined]=2026-13-01..'],
      ['a reversed date range', 'filter[joined]=2026-03-01..2026-02-01'],
      ['a page size the table does not offer', 'per_page=10000'],
      ['a page that is none', 'page=0'],
      ['two sorts', 'sort=name&sort=-name'],
      ['a search that is too long', `search=${'x'.repeat(101)}`],
    ])('%s → 400', async (_what, query) => {
      const application = await app(driver);
      const { status } = await page(application, ADA, query);
      expect(status, `${query} answered ${status}`).toBe(400);
    });

    it('counter-check: a filter on a hidden column is hidden with it (400) — its counts would tell the values (W9 step 10b)', async () => {
      const application = await app(driver);
      const hidden = await application.request('/teams/1/leaky?filter[since]=2026-02-01..', { user: ALAN });
      expect(hidden.status, 'a filter on a hidden column was used').toBe(400);
      const { leaky } = (await (await application.request('/teams/1/leaky', { user: ALAN })).json()) as { leaky: Members };
      expect(leaky.filters, 'a filter on a hidden column was offered').toEqual([]);
      const shown = await application.request('/teams/1/leaky?filter[since]=2026-02-01..', { user: ADA });
      expect(shown.status).toBe(200);
      expect(((await shown.json()) as { leaky: Members }).leaky.rows.map((row) => row.name)).not.toContain('Ada');
    });

    it('a hidden column cannot be sorted by (400) — the order would tell its values', async () => {
      const application = await app(driver);
      expect((await page(application, ALAN, 'sort=email')).status, 'a hidden column was sortable').toBe(400);
      expect((await page(application, ADA, 'sort=email')).status).toBe(200);
    });

    it('leaves keys that are not the table\'s to the page', async () => {
      const application = await app(driver);
      expect((await page(application, ALAN, 'utm_source=mail&tab=x')).status).toBe(200);
    });
  });

  describe('row actions (POST …/actions/:action)', () => {
    const run = (application: TableTestApp, user: number | undefined, key: unknown, action = 'deactivate', team = 1) =>
      application.request(`/teams/${team}/_tables/members/actions/${action}`, { method: 'POST', user, json: { key } });

    it('runs for a row of the table the policy allows — and answers with what it did', async () => {
      const application = await app(driver);
      const response = await run(application, ADA, 2);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ done: 1, skipped: 0, missing: 0 });
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(application.recorder.deactivated).toEqual([2]);
    });

    it('asks the policy again: a row it refuses is a 403 — whatever the page showed', async () => {
      const application = await app(driver);
      expect((await run(application, ADA, 1)).status, 'the policy was not asked again').toBe(403); // yourself
      expect((await run(application, ADA, 3)).status, 'the policy was not asked again').toBe(403); // protected
      expect(application.recorder.deactivated).toEqual([]);
    });

    it('checks the action\'s visibility again: hidden by its policy, its endpoint is a 403', async () => {
      const application = await app(driver);
      // Edsger is a row the policy would allow for Alan — only the action's visibility (administrators) stands in the way.
      expect((await run(application, ALAN, 4)).status, 'a hidden action ran').toBe(403);
      expect(application.recorder.deactivated).toEqual([]);
    });

    it('looks the row up in the base query: another team\'s, a missing or a made-up key is a 404', async () => {
      const application = await app(driver);
      expect((await run(application, ADA, 9)).status, 'a key of another team was acted on').toBe(404);
      expect((await run(application, ADA, 777)).status).toBe(404);
      expect((await run(application, ADA, 'abc')).status).toBe(404);
      expect(application.recorder.deactivated).toEqual([]);
    });

    it('refuses an unknown action (404), a body without a key (422) and a guest (the page\'s middleware: 401)', async () => {
      const application = await app(driver);
      expect((await run(application, ADA, 2, 'delete')).status).toBe(404);
      expect((await application.request('/teams/1/_tables/members/actions/deactivate', { method: 'POST', user: ADA, json: {} })).status).toBe(422);
      expect((await run(application, undefined, 2)).status).toBe(401);
      expect((await run(application, MALLORY, 2)).status).toBe(404); // not her team: the tenant middleware
      expect(application.recorder.deactivated).toEqual([]);
    });
  });

  describe('keys are parsed by the key\'s type before any query', () => {
    it('a text key (`{ column, type: \'string\' }`) takes text — a number is just text that matches no row', async () => {
      const application = await app(driver);
      const run = (key: unknown) => application.request('/teams/1/_tables/by-email/actions/deactivate', { method: 'POST', user: ADA, json: { key } });
      expect((await run('alan@example.com')).status).toBe(200);
      expect((await run(2)).status).toBe(404);
      expect(application.recorder.deactivated).toEqual(['alan@example.com']);
    });

    it('an integer key never sends text to the database (Postgres would fail: a 500) — no row, no query for it', async () => {
      const application = await app(driver);
      application.queries.length = 0;
      const response = await application.request('/teams/1/_tables/members/actions/deactivate', { method: 'POST', user: ADA, json: { key: 'abc' } });
      expect(response.status, 'text reached an integer key column').toBe(404);
      expect(application.queries.some((query) => query.parameters.includes('abc')), 'text reached an integer key column').toBe(false);
      const bulk = await application.request('/teams/1/_tables/members/bulk/deactivate', { method: 'POST', user: ADA, json: { keys: ['abc', '2', '2.5', '99999999999999999'] } });
      expect(await bulk.json()).toMatchObject({ done: 1, missing: 3 });
      expect(application.queries.some((query) => query.parameters.includes('abc')), 'text reached an integer key column').toBe(false);
    });
  });

  describe('bulk actions (POST …/bulk/:action)', () => {
    const run = (application: TableTestApp, user: number | undefined, body: unknown) =>
      application.request('/teams/1/_tables/members/bulk/deactivate', { method: 'POST', user, json: body });

    it('keys ∩ the base query: keys that are no rows of the table (another team\'s, none) are left out and counted', async () => {
      const application = await app(driver);
      const response = await run(application, ADA, { keys: [2, 9, 777] });
      expect(response.status).toBe(200);
      expect(application.recorder.batches, 'a key outside the base query was acted on').toEqual([[2]]);
      expect(await response.json()).toEqual({ done: 1, skipped: 0, missing: 2, data: { last: 2 } });
      expect(await (await run(application, ADA, { keys: ['x'] })).json()).toEqual({ done: 0, skipped: 0, missing: 1 });
    });

    it('∩ the policy per row: rows of the table it refuses are left out and counted', async () => {
      const application = await app(driver);
      const response = await run(application, ADA, { keys: [2, 3, 1, 4] });
      expect(response.status).toBe(200);
      // 3 (protected) and 1 (yourself): refused by the policy; 2 and 4 done.
      expect(application.recorder.batches, 'a row the policy refuses was acted on').toEqual([[2, 4]]);
      expect(await response.json()).toEqual({ done: 2, skipped: 2, missing: 0, data: { last: 4 } });
    });

    it('"all matching": the filter state, parsed again on the server — never a list of keys from the browser', async () => {
      const application = await app(driver);
      const response = await run(application, ADA, { all: true, query: { 'filter[role]': 'member', sort: '-joined' } });
      expect(await response.json()).toEqual({ done: 2, skipped: 1, missing: 0, data: { last: 2 } });
      expect(application.recorder.batches).toEqual([[4, 2]]);
      expect((await run(application, ADA, { all: true, query: { sort: 'password' } })).status).toBe(400);
    });

    it('refuses more rows than its max (422) — chosen ones or all matching — and runs nothing', async () => {
      const application = await app(driver);
      await application.insert([5, 6, 7].map((id) => ({ ...MEMBERS[1]!, id, name: `Member ${id}`, email: `m${id}@example.com` })));
      expect((await run(application, ADA, { keys: [1, 2, 3, 4, 5, 6] })).status, 'more chosen keys than max were taken').toBe(422);
      const all = await run(application, ADA, { all: true, query: {} });
      expect(all.status, 'more matching rows than max were acted on').toBe(422);
      expect(JSON.stringify(await all.json())).toContain('More than 5 rows');
      expect(application.recorder.batches).toEqual([]);
    });

    it('is hidden from who may not see it (403), and needs the page\'s middleware (401)', async () => {
      const application = await app(driver);
      expect((await run(application, ALAN, { keys: [4] })).status, 'a hidden bulk action ran').toBe(403);
      expect((await run(application, undefined, { keys: [2] })).status).toBe(401);
      expect(application.recorder.batches).toEqual([]);
    });
  });

  describe('CSV export (GET …/export/:export)', () => {
    const csv = (application: TableTestApp, user: number | undefined, query = '') => application.request(`/teams/1/_tables/members/export/csv${query ? `?${query}` : ''}`, { user });

    it('streams the visible columns as the table is filtered and sorted — no-store, a safe file name', async () => {
      const application = await app(driver);
      const response = await csv(application, ADA, 'sort=-joined&filter[role]=member');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"$/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A byte order mark first: spreadsheets read UTF-8 (umlauts) only with it.
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      expect(text.split('\r\n')).toEqual([
        '"name","email","role","joined","seen"',
        '"Edsger","edsger@example.com","member",' + text.split('\r\n')[1]!.split(',').slice(3).join(','),
        expect.stringMatching(/^"Grace","grace@example\.com","member",/),
        expect.stringMatching(/^"Alan","alan@example\.com","member",/),
        '',
      ]);
    });

    it('leaves a hidden column out — for who may export but not see it', async () => {
      const application = await app(driver);
      const text = await (await csv(application, EDSGER)).text();
      expect(text.split('\r\n')[0], 'a hidden column reached the export').toBe('"name","role","joined","seen"');
      expect(text, 'a hidden column reached the export').not.toContain('@example.com');
    });

    it('escapes formulas (OWASP): a cell that starts with = + - @ tab CR LF gets a quote — quotes doubled, every field quoted', async () => {
      const application = await app(driver);
      await application.insert([
        { ...MEMBERS[1]!, id: 20, name: '=HYPERLINK("http://evil.example","x")', email: 'e1@example.com' },
        { ...MEMBERS[1]!, id: 21, name: '@SUM(1+1)', email: 'e2@example.com' },
      ]);
      const text = await (await csv(application, ADA, 'search=sum')).text();
      expect(text, 'a formula reached the CSV').toContain('"\'@SUM(1+1)"');
      const all = await (await csv(application, ADA)).text();
      expect(all, 'a formula reached the CSV').toContain('"\'=HYPERLINK(""http://evil.example"",""x"")"');
      expect(all).not.toMatch(/(^|,)"=/m);
    });

    it('streams large exports in batches — every row once', async () => {
      const application = await app(driver);
      await application.insert(Array.from({ length: 1203 }, (_, index) => ({ ...MEMBERS[1]!, id: 100 + index, name: `Bulk ${String(index).padStart(4, '0')}`, email: `b${index}@example.com` })));
      const lines = (await (await csv(application, ADA, 'search=bulk')).text()).split('\r\n').filter(Boolean);
      expect(lines).toHaveLength(1204);
      expect(new Set(lines).size).toBe(1204);
    });

    it('goes on after the last row it wrote, not at an offset — rows deleted or added meanwhile shift nothing', async () => {
      const application = await app(driver);
      await application.insert(Array.from({ length: 600 }, (_, index) => ({ ...MEMBERS[1]!, id: 100 + index, name: `Bulk ${String(index).padStart(4, '0')}`, email: `b${index}@example.com` })));
      // The first batch (500 rows) is written before the answer; the next is read when the client reads on.
      const response = await csv(application, ADA, 'search=bulk&sort=name');
      const db = application.connections.get();
      // Meanwhile: two rows of the first batch are deleted, and one is added before where the export stands.
      await db.deleteFrom('members').where('id', 'in', [100, 101]).execute();
      await application.insert([{ ...MEMBERS[1]!, id: 900, name: 'Bulk 0000a', email: 'added@example.com' }]);
      const rows = (await response.text()).split('\r\n').filter(Boolean).slice(1).map((line) => line.slice(1, line.indexOf('"', 1)));
      const expected = Array.from({ length: 600 }, (_, index) => `Bulk ${String(index).padStart(4, '0')}`);
      const missing = expected.filter((name) => !rows.includes(name));
      const twice = rows.filter((name, index) => rows.indexOf(name) !== index);
      expect({ missing, twice }, JSON.stringify({ missing, twice })).toEqual({ missing: [], twice: [] });
      expect(rows).toEqual(expected);
    });

    it('refuses an export over its limit (422) before streaming a byte — never a file cut short', async () => {
      const application = await app(driver);
      const response = await application.request('/teams/1/_tables/small/export/csv', { user: ADA });
      expect(response.status, 'an export over its limit was streamed').toBe(422);
      expect(await response.text()).toContain('More than 3 rows match');
    });

    it('streams its later batches outside the transaction the handler answered in (a framework boundary, E107)', async () => {
      const application = await app(driver);
      await application.insert(Array.from({ length: 1203 }, (_, index) => ({ ...MEMBERS[1]!, id: 100 + index, name: `Bulk ${index}`, email: `b${index}@example.com` })));
      const response = await application.request('/teams/1/export-in-transaction', { user: ADA });
      expect(response.status).toBe(200);
      let text = '';
      try {
        text = await response.text();
      } catch (error) {
        text = `the stream failed: ${String(error)}`;
      }
      expect(text, 'a later batch ran in the finished transaction').not.toContain('the stream failed');
      expect(text.split('\r\n').filter(Boolean)).toHaveLength(1208); // header + 4 members + 1 203
    });

    it('has its own authorization: who may see the table but not export gets a 403 — a guest the middleware\'s 401', async () => {
      const application = await app(driver);
      expect((await csv(application, ALAN)).status, 'the export ran without its authorization').toBe(403);
      expect((await csv(application, undefined)).status).toBe(401);
      expect((await csv(application, ADA, 'sort=password')).status).toBe(400);
      expect((await csv(application, EDSGER, 'sort=email')).status).toBe(400);
    });
  });

  describe('wiring', () => {
    it('a page whose route does not parse the table\'s query is a programming error that says what to do', async () => {
      const application = await app(driver);
      expect((await application.request('/teams/1/no-schema', { user: ALAN })).status).toBe(500);
      const tables = application.application.container.createScope().make(Tables);
      const ctx = { request: new Request('http://localhost/teams/1/members'), query: new URLSearchParams(), user: USERS[ALAN], team: 1 };
      await expect(tables.resolve(MembersTable, ctx as never)).rejects.toThrow('give its request the table\'s schema: defineRequest({ query: membersTable.query })');
    });

    it('answers an action request (x-marmeon-action) like useAction expects — JSON, no-store', async () => {
      const application = await app(driver);
      const response = await application.request('/teams/1/_tables/members/actions/deactivate', { method: 'POST', user: ADA, json: { key: 4 }, action: true });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({ done: 1, skipped: 0, missing: 0 });
    });

    it('a form posted without JavaScript goes back to the page (303) — the same checks, keys as text', async () => {
      const application = await app(driver);
      const back = { accept: 'text/html', referer: 'http://localhost/teams/1/members?sort=-joined' };
      const row = await application.request('/teams/1/_tables/members/actions/deactivate', { method: 'POST', user: ADA, form: 'key=2', headers: back });
      expect(row.status).toBe(303);
      expect(row.headers.get('location')).toBe('/teams/1/members?sort=-joined');
      const many = await application.request('/teams/1/_tables/members/bulk/deactivate', { method: 'POST', user: ADA, form: 'keys[]=4&keys[]=3&keys[]=9', headers: back });
      expect(many.status).toBe(303);
      // "All matching" without JavaScript: `all=1`, the table's state in the bulk URL's query.
      const all = await application.request('/teams/1/_tables/members/bulk/deactivate?filter%5Brole%5D=admin', { method: 'POST', user: ADA, form: 'all=1', headers: back });
      expect(all.status).toBe(303);
      expect(application.recorder.deactivated).toEqual([2]);
      expect(application.recorder.batches).toEqual([[4]]);
      // A refused one is the same 403 — never a redirect that hides it.
      expect((await application.request('/teams/1/_tables/members/actions/deactivate', { method: 'POST', user: ADA, form: 'key=3', headers: back })).status).toBe(403);
    });
  });
});
