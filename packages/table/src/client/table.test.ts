// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/members" }
/**
 * The headless table on the client core alone — a plain-DOM adapter (it renders the table's rows as text) drives `TableController`
 * through sorting, filtering and paging (query-state visits with the props' aliases and keys), selecting (the entry's slot), row and
 * bulk actions (the actions feature, then the table's prop reloaded — replacing what the page had) and an export URL. No UI framework.
 */
import { ACTION_HEADER, PAGE_HEADER, PARTIAL_DATA_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { selection } from '@marmeon/http/client/adapter';
import { loadHistoryFallback, Navigator } from '@marmeon/http/client/adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TableController, tableStatus, type TableData } from './index.ts';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

type Row = { id: number; name: string; joined: string; email?: string };
type Members = TableData<Row, 'name' | 'joined' | 'email', 'locale' | 'joined', 'removeLinks', 'removeLinks', 'csv', 'name' | 'joined'>;

const ALL: Row[] = [
  { id: 1, name: 'Ada', joined: '2026-01-01' },
  { id: 2, name: 'Grace', joined: '2026-02-01' },
  { id: 3, name: 'Alan', joined: '2026-03-01' },
];

/** The table's props as the server resolves them for a query. */
function members(query: URLSearchParams, rows = live): Members {
  const sort = query.get('sort') ?? 'name';
  const column = sort.replace(/^-/, '') as 'name' | 'joined';
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const locale = query.get('filter[locale]');
  const state: Record<string, string> = {};
  if (query.has('sort')) state.sort = sort;
  if (locale) state['filter[locale]'] = locale;
  return {
    name: 'members',
    key: 'id',
    columns: [
      { name: 'name', label: null, sortable: true, searchable: true, sort: column === 'name' ? direction : null },
      { name: 'joined', label: null, sortable: true, searchable: false, sort: column === 'joined' ? direction : null },
      { name: 'email', label: null, sortable: false, searchable: false, sort: null },
    ],
    rows: rows.map((row) => ({ ...row, can: { removeLinks: row.id !== 1 } })),
    sort: { column, direction },
    search: { value: query.get('search') ?? '' },
    filters: [
      { name: 'locale', type: 'select', key: 'filter[locale]', options: ['en', 'de'], value: locale },
      { name: 'joined', type: 'dateRange', key: 'filter[joined]', value: null },
    ],
    page: { type: 'offset', page: Number(query.get('page') ?? 1), perPage: 10, perPageOptions: [10, 25], total: rows.length, lastPage: 3, from: 1, to: rows.length },
    query: { sort: 'sort', page: 'page', perPage: 'per_page', cursor: 'cursor', search: 'search' },
    state,
    actions: [{ name: 'removeLinks', url: '/members/_tables/members/actions/removeLinks', confirm: true }],
    bulk: [{ name: 'removeLinks', url: '/members/_tables/members/bulk/removeLinks', confirm: false, max: 100 }],
    exports: [{ name: 'csv', format: 'csv', url: `/members/_tables/members/export/csv?${new URLSearchParams(state)}`, max: 10_000 }],
  };
}

/** The rows the server has now — an action takes one away. */
let live: Row[] = [];
const requests: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];

/** A "load more" page marks the table's prop deep-merged — a revalidation must still replace it. */
const MERGED: Pick<PageObject, 'deepMergeProps' | 'matchPropsOn'> = { deepMergeProps: ['members'], matchPropsOn: ['members.rows.id', 'members.columns.name', 'members.filters.name', 'members.actions.name', 'members.bulk.name', 'members.exports.name'] };

function pageOf(url: URL): PageObject {
  const query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'page' || url.searchParams.get('page') !== '1'));
  return {
    component: 'members/Index',
    url: url.pathname + url.search,
    props: { title: 'Members', members: members(url.searchParams) },
    version: 'v1',
    query: { ...query, ...(query.page ? { page: Number(query.page) } : {}) },
    queryDefaults: { sort: 'name', page: 1, per_page: 10, search: '' },
    ...MERGED,
  };
}

async function server(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'https://app.test');
  const headers = { ...(init.headers as Record<string, string>) };
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers, body });
  if (url.pathname.startsWith('/members/_tables/members/')) {
    const keys = url.pathname.includes('/bulk/') ? ((body as { keys?: number[]; all?: true }).all ? live.map((row) => row.id) : (body as { keys: number[] }).keys) : [(body as { key: number }).key];
    live = live.filter((row) => !keys.includes(row.id));
    return Response.json({ done: keys.length, skipped: 0, missing: 0 });
  }
  const page = pageOf(url);
  const only = headers[PARTIAL_DATA_HEADER]?.split(',');
  if (only) page.props = Object.fromEntries(only.map((name) => [name, page.props[name]]));
  return new Response(JSON.stringify(page), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'content-type': 'application/json' } });
}

/** The adapter: the page as text — the table's names in order. */
function textApp() {
  const root = document.body;
  const shown: PageObject[] = [];
  const render = async (page: PageObject) => {
    shown.push(page);
    root.textContent = (page.props.members as Members).rows.map((row) => row.name).join(', ');
  };
  const initialPage = pageOf(new URL('https://app.test/members'));
  void render(initialPage);
  const navigator = new Navigator({ initialPage, render, confirm: () => true, features: HISTORY });
  const stop = navigator.start();
  const table = () => new TableController(navigator, navigator.page.props.members as Members);
  return { navigator, root, shown, table, stop };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let app: ReturnType<typeof textApp>;

beforeEach(() => {
  live = ALL.map((row) => ({ ...row }));
  requests.length = 0;
  window.fetch = server as typeof fetch;
  document.cookie = 'XSRF-TOKEN=token';
  history.replaceState(null, '', '/members');
  app = textApp();
});

afterEach(() => app.stop());

describe('the headless table on the client core alone', () => {
  it('sorts by the alias the props name — a visit of the page with ?sort=, only the table’s prop, back to page 1', async () => {
    const table = app.table();
    table.sort('joined');
    await settle();
    expect(requests.at(-1)).toMatchObject({ method: 'GET', url: '/members?sort=joined', headers: { [PARTIAL_DATA_HEADER]: 'members' } });
    expect(app.navigator.page.url).toBe('/members?sort=joined');
    // Sorted ascending already: the same column the other way round.
    const sorted = new TableController(app.navigator, app.navigator.page.props.members as Members);
    sorted.sort('joined');
    await settle();
    expect(requests.at(-1)!.url).toBe('/members?sort=-joined');
  });

  it('never sends a sort the props do not offer — a database column, a hidden or an unsortable one is a programming error', async () => {
    const table = app.table();
    const refused: string[] = [];
    const attempt = (sort: () => void) => {
      try {
        sort();
      } catch (error) {
        refused.push((error as Error).message);
      }
    };
    // @ts-expect-error — not a sortable column of the table
    attempt(() => table.sort('created_at'));
    // @ts-expect-error — visible, not sortable
    attempt(() => table.sort('email'));
    await settle();
    expect(requests.map((request) => request.url), 'a sort the props do not offer went out').toEqual([]);
    expect(refused).toEqual([
      '[marmeon:C9] The table "members" does not sort by "created_at" — it sorts by name, joined (the columns\' names in its props, never a database column).',
      '[marmeon:C9] The table "members" does not sort by "email" — it sorts by name, joined (the columns\' names in its props, never a database column).',
    ]);
  });

  it('filters by the key the props name and starts again at page 1; a select filter takes its options only', async () => {
    const table = app.table();
    table.goTo(2);
    await settle();
    expect(requests.at(-1)!.url).toBe('/members?page=2');
    new TableController(app.navigator, app.navigator.page.props.members as Members).filter('locale', 'de');
    await settle();
    expect(requests.at(-1)!.url).toBe('/members?filter%5Blocale%5D=de');
    expect(() => table.filter('locale', 'fr')).toThrow('[marmeon:C10] The filter "locale" of the table "members" takes en, de — not "fr".');
    // @ts-expect-error — no such filter
    expect(() => table.filter('role', 'admin')).toThrow('has no filter "role"');
    new TableController(app.navigator, app.navigator.page.props.members as Members).filter('locale', null);
    await settle();
    expect(requests.at(-1)!.url).toBe('/members');
  });

  it('takes a filter and a page kind it does not know: filtering goes through, paging by number or cursor is refused', async () => {
    const data = app.navigator.page.props.members as Members;
    const open = {
      ...data,
      filters: [{ name: 'age', type: 'numberRange', key: 'filter[age]', value: null }] as never,
      page: { type: 'keyset', perPage: 10, perPageOptions: [10], nextCursor: 'x' } as never,
    } as Members;
    const table = new TableController(app.navigator, open);
    // @ts-expect-error — the name is not one of the typed filters
    table.filter('age', '1..2');
    await settle();
    expect(requests.at(-1)!.url).toBe('/members?filter%5Bage%5D=1..2');
    expect(() => table.goTo(2)).toThrow('[marmeon:C11]');
    expect(() => table.next()).toThrow('[marmeon:C11]');
  });

  it('sets several filters in one visit — and none when nothing changed', async () => {
    const table = app.table();
    table.filterBy({ locale: null, joined: null });
    await settle();
    expect(requests).toEqual([]);
    table.filterBy({ locale: 'en', joined: '2026-01-01..' });
    await settle();
    expect(requests.map((request) => request.url)).toEqual(['/members?filter%5Blocale%5D=en&filter%5Bjoined%5D=2026-01-01..']);
    // @ts-expect-error — no such filter
    expect(() => table.filterBy({ role: 'admin' })).toThrow('has no filter "role"');
  });

  it('a sort link works without JavaScript: the URL of the page sorted the other way, its defaults left out', () => {
    const table = app.table();
    expect(table.sortUrl('name', app.navigator.page)).toBe('/members?sort=-name');
    expect(table.sortUrl('joined', app.navigator.page)).toBe('/members?sort=joined');
  });

  it('selects rows in the slot of the page’s history entry — a sort is another entry, which starts with nothing selected', async () => {
    const table = app.table();
    const [ada, grace] = table.data.rows;
    table.select(ada!);
    table.toggle(grace!);
    expect([table.isSelected(ada!), table.isSelected(grace!), table.selectedCount, table.allSelected]).toEqual([true, true, 2, false]);
    expect(app.navigator.use(selection).of('members').keys).toEqual([1, 2]);
    table.selectAll();
    expect(table.allSelected).toBe(true);
    table.selectAll(false);
    expect(table.selectedCount).toBe(0);
    table.select(ada!);
    table.sort('joined');
    await settle();
    // The same controller (a component kept across the visit) reads the new entry's: nothing selected.
    table.update(app.navigator.page.props.members as Members);
    expect(table.selectedCount).toBe(0);
    // Back: the entry's selection from memory.
    history.back();
    await settle();
    expect(app.navigator.page.url).toBe('/members');
    table.update(app.navigator.page.props.members as Members);
    expect([table.selectedCount, table.isSelected(ada!)]).toEqual([1, true]);
  });

  it('runs a row action as an action request with the row’s key, then reloads the table — replacing the deep-merged rows', async () => {
    const table = app.table();
    const grace = table.data.rows[1]!;
    const outcome = await table.run('removeLinks', grace);
    expect(outcome).toMatchObject({ ok: true, kind: 'data', data: { done: 1, skipped: 0, missing: 0 } });
    const [action, reload] = requests;
    expect(action).toMatchObject({ method: 'POST', url: '/members/_tables/members/actions/removeLinks', headers: { [ACTION_HEADER]: 'true', 'x-xsrf-token': 'token' }, body: { key: 2 } });
    expect(reload).toMatchObject({ method: 'GET', url: '/members', headers: { [PARTIAL_DATA_HEADER]: 'members' } });
    // The page marks the table deep-merged ("load more"): a revalidation replaces it anyway — Grace does not come back.
    expect((app.navigator.page.props.members as Members).rows.map((row) => row.name), 'the removed row came back').toEqual(['Ada', 'Alan']);
    expect(app.root.textContent).toBe('Ada, Alan');
    expect(app.navigator.page.props.title).toBe('Members');
  });

  it('a bulk run whose page was left before the answer still resolves ok — the selection of the entry that is gone is detached', async () => {
    const table = new TableController(app.navigator, app.navigator.page.props.members as Members, { entry: app.navigator.regionOwner.entry! });
    table.select(table.data.rows[1]!);
    const run = table.runBulk('removeLinks');
    await app.navigator.visit('/members?page=2');
    await expect(run).resolves.toMatchObject({ ok: true });
  });

  it('a bulk action sends the keys ticked — and, for every matching row, the table’s state: never a list of keys', async () => {
    const table = app.table();
    table.select(table.data.rows[1]!);
    table.select(table.data.rows[2]!);
    await table.runBulk('removeLinks');
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/members/_tables/members/bulk/removeLinks', body: { keys: [2, 3] } });
    expect(table.selectedCount).toBe(0);
    expect(app.root.textContent, 'the removed rows came back').toBe('Ada');

    live = ALL.map((row) => ({ ...row }));
    requests.length = 0;
    new TableController(app.navigator, app.navigator.page.props.members as Members).filter('locale', 'de');
    await settle();
    const filtered = new TableController(app.navigator, app.navigator.page.props.members as Members);
    filtered.selectMatching();
    expect(filtered.selectedCount).toBe(3);
    await filtered.runBulk('removeLinks');
    const bulk = requests.find((request) => request.method === 'POST')!;
    expect(bulk.body, '"all matching" sent something else than the table’s state').toEqual({ all: true, query: { 'filter[locale]': 'de' } });
    expect(filtered.selection.matching).toBe(false);
  });

  it('asks before an action defined with .confirm() — a no sends nothing', async () => {
    const asked: string[] = [];
    app.stop();
    const initialPage = pageOf(new URL('https://app.test/members'));
    const navigator = new Navigator({ initialPage, render: async () => {}, confirm: (request) => (asked.push(request.message), false), features: HISTORY });
    app.stop = navigator.start();
    const table = new TableController(navigator, initialPage.props.members as Members);
    table.confirmText = (action, rows) => `${action}: ${rows}?`;
    expect(await table.run('removeLinks', table.data.rows[1]!)).toEqual({ ok: false, kind: 'cancelled' });
    expect(asked).toEqual(['removeLinks: 1?']);
    expect(requests).toEqual([]);
  });

  it('offers only what the props offer — an action, a bulk action or an export they lack is a programming error', () => {
    const table = app.table();
    expect(table.exportUrl('csv')).toBe('/members/_tables/members/export/csv?');
    // @ts-expect-error — no such export
    expect(() => table.exportUrl('xlsx')).toThrow('[marmeon:C12] The table "members" offers no export "xlsx" to this user — it offers csv.');
    // @ts-expect-error — no such action
    expect(() => table.run('promote', table.data.rows[0]!)).toThrow('offers no row action "promote"');
  });

  it('says what the live region reads out', () => {
    expect(tableStatus({ total: 42, shown: 10, sort: { column: 'joined', label: 'Joined', direction: 'desc' }, page: { page: 2, lastPage: 5 } })).toBe('42 rows, sorted by Joined (descending), page 2 of 5');
    expect(tableStatus({ total: 1, shown: 1, sort: null, page: null })).toBe('1 row');
    expect(tableStatus({ total: null, shown: 10, sort: null, page: null })).toBe('10 rows shown');
  });
});
