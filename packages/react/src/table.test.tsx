// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/members" }
import { ACTION_HEADER, PAGE_HEADER, PARTIAL_DATA_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import type { TableData } from '@marmeon/table/client';
import { rowPaginationFeature, rowSelectionFeature, rowSortingFeature, tableFeatures, useTable as useTanStackTable } from '@tanstack/react-table';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { createSsrRenderer } from './server.tsx';
import { useTable, type TableLabels } from './table.ts';
import { toTanStack } from './table-tanstack.ts';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number; name: string; joined: string };
type Members = TableData<Row, 'name' | 'joined' | 'links', 'locale', 'removeLinks', 'removeLinks', 'csv', 'name' | 'joined'>;

const ALL: Row[] = [
  { id: 1, name: 'Ada Lovelace', joined: '2026-01-01' },
  { id: 2, name: 'Grace Hopper', joined: '2026-02-01' },
  { id: 3, name: 'Alan Turing', joined: '2026-03-01' },
];
let live: Row[] = [];

function members(query: URLSearchParams): Members {
  const sort = query.get('sort') ?? 'name';
  const column = sort.replace(/^-/, '') as 'name' | 'joined';
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const state: Record<string, string> = query.has('sort') ? { sort } : {};
  return {
    name: 'members',
    key: 'id',
    columns: [
      { name: 'name', label: null, sortable: true, searchable: true, sort: column === 'name' ? direction : null },
      { name: 'joined', label: 'Joined', sortable: true, searchable: false, sort: column === 'joined' ? direction : null },
      { name: 'links', label: null, sortable: false, searchable: false, sort: null },
    ],
    rows: live.map((row) => ({ ...row, can: { removeLinks: row.id !== 1 } })),
    sort: { column, direction },
    search: { value: '' },
    filters: [{ name: 'locale', type: 'select', key: 'filter[locale]', options: ['en', 'de'], value: query.get('filter[locale]') }],
    page: { type: 'offset', page: 1, perPage: 10, perPageOptions: [10, 25], total: live.length, lastPage: 1, from: 1, to: live.length },
    query: { sort: 'sort', page: 'page', perPage: 'per_page', cursor: 'cursor', search: 'search' },
    state,
    actions: [{ name: 'removeLinks', url: '/members/_tables/members/actions/removeLinks', confirm: false }],
    bulk: [{ name: 'removeLinks', url: '/members/_tables/members/bulk/removeLinks', confirm: false, max: 100 }],
    exports: [{ name: 'csv', format: 'csv', url: `/members/_tables/members/export/csv?${new URLSearchParams(state)}`, max: 10_000 }],
  };
}

const pageOf = (url: string, component = 'app/Members'): PageObject => {
  const parsed = new URL(url, 'https://app.test');
  const query = Object.fromEntries(parsed.searchParams);
  return { component, url: parsed.pathname + parsed.search, props: { members: members(parsed.searchParams) }, version: null, query, queryDefaults: { sort: 'name', page: 1, per_page: 10, search: '' } };
};

const GERMAN: TableLabels<Members> = {
  column: (name) => ({ name: 'Name', joined: 'Beigetreten', links: 'Links' })[name],
  row: (row) => row.name,
  status: ({ total, sort }) => `${total} Mitglieder${sort ? `, sortiert nach ${sort.label} (${sort.direction === 'asc' ? 'aufsteigend' : 'absteigend'})` : ''}`,
  select: (row) => `${row} auswählen`,
  selectPage: () => 'Alle auf dieser Seite auswählen',
  action: (_action, row) => `Links entfernen: ${row}`,
};

function MembersPage({ members: data }: { members: Members }) {
  const table = useTable(data, { labels: GERMAN });
  return (
    <main>
      <p {...table.statusProps} data-testid="status">
        {table.status}
      </p>
      <button type="button" data-testid="bulk" onClick={() => void table.runBulk('removeLinks')}>
        {table.selectedCount}
      </button>
      <button type="button" data-testid="matching" onClick={() => table.selectMatching()}>
        all
      </button>
      <table>
        <caption>Mitglieder</caption>
        <thead>
          <tr>
            <th scope="col">
              <input {...table.pageCheckboxProps()} />
            </th>
            {table.columns.map((column) => (
              <th key={column.name} {...column.headerProps}>
                {column.sortable ? (
                  <button type="button" onClick={column.toggleSort} data-sort-url={column.sortUrl}>
                    {column.label}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
            <th scope="col">Aktionen</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.id}>
              <td>
                <input {...table.checkboxProps(row)} />
              </td>
              <td>{row.name}</td>
              <td>{row.joined}</td>
              <td>0</td>
              <td>
                {table.can('removeLinks', row) && (
                  <button type="button" aria-label={table.actionLabel('removeLinks', row)} onClick={() => void table.run('removeLinks', row)}>
                    Links entfernen
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <a href={table.exportUrl('csv')} download data-testid="csv">
        CSV
      </a>
    </main>
  );
}

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, rowSelectionFeature });

function TanStackPage({ members: data }: { members: Members }) {
  const table = useTable(data);
  const tanstack = useTanStackTable(toTanStack(table, { features }));
  return (
    <table>
      <thead>
        {tanstack.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id} data-testid={`th-${header.id}`} onClick={header.column.getToggleSortingHandler()}>
                <tanstack.FlexRender header={header} />
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {tanstack.getRowModel().rows.map((row) => (
          <tr key={row.id} data-testid={`row-${row.id}`} data-selected={String(row.getIsSelected())}>
            {row.getAllCells().map((cell) => (
              <td key={cell.id}>
                <tanstack.FlexRender cell={cell} />
              </td>
            ))}
            <td>
              <input type="checkbox" data-testid={`select-${row.id}`} checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const pages: Record<string, PageComponent> = { Members: MembersPage as PageComponent, TanStack: TanStackPage as PageComponent };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));

let requests: { method: string; url: string; headers: Record<string, string>; body: unknown }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  live = ALL.map((row) => ({ ...row }));
  history.replaceState(null, '', '/members');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input).replace(window.location.origin, '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const headers = { ...(init.headers as Record<string, string>) };
    requests.push({ method: init.method ?? 'GET', url, headers, body });
    if (url.includes('/_tables/')) {
      const keys = (body as { key?: number; keys?: number[]; all?: true }).all ? live.map((row) => row.id) : ((body as { keys?: number[] }).keys ?? [(body as { key: number }).key]);
      live = live.filter((row) => !keys.includes(row.id));
      return Response.json({ done: keys.length, skipped: 0, missing: 0 });
    }
    const page = pageOf(url, document.body.dataset.component ?? 'app/Members');
    return new Response(JSON.stringify(page), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'content-type': 'application/json' } });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  delete document.body.dataset.component;
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} />));
}

const $ = <E extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<E>(selector)!;
const wait = (ms: number) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));
async function until(assertion: () => void, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await wait(5);
    try {
      return assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}
const click = (element: HTMLElement) => act(async () => void element.click());

describe('useTable — accessible markup from the props', () => {
  it('puts aria-sort on the sorted heading only — never "none" on the others — and names checkboxes, buttons and the live region', async () => {
    await mount(pageOf('/members?sort=-joined'));
    const headings = [...container.querySelectorAll('thead th')];
    expect(headings.map((th) => th.getAttribute('aria-sort')), 'aria-sort on a heading the table is not sorted by').toEqual([null, null, 'descending', null, null]);
    expect(headings.filter((th) => th.hasAttribute('aria-sort'))).toHaveLength(1);
    expect(headings.slice(1, 4).map((th) => th.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    expect($('[data-testid="status"]').textContent).toBe('3 Mitglieder, sortiert nach Beigetreten (absteigend)');
    expect($('[data-testid="status"]').getAttribute('role')).toBe('status');
    expect($('[data-testid="status"]').getAttribute('aria-live')).toBe('polite');
    expect([...container.querySelectorAll('tbody input[type="checkbox"]')].map((input) => input.getAttribute('aria-label'))).toEqual([
      'Ada Lovelace auswählen',
      'Grace Hopper auswählen',
      'Alan Turing auswählen',
    ]);
    expect($('thead input').getAttribute('aria-label')).toBe('Alle auf dieser Seite auswählen');
    // Ada's row has no action (her policy said no): no button at all, not a disabled one.
    expect([...container.querySelectorAll('tbody button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Links entfernen: Grace Hopper', 'Links entfernen: Alan Turing']);
    // Sort links that work without JavaScript: the aliases, the defaults left out, back on page 1.
    expect([...container.querySelectorAll('thead button')].map((button) => button.getAttribute('data-sort-url'))).toEqual(['/members', '/members?sort=joined']);
    expect($('[data-testid="csv"]').getAttribute('href')).toBe('/members/_tables/members/export/csv?sort=-joined');
  });

  it('renders the same on the server — nothing selected, no navigator needed', async () => {
    const render = createSsrRenderer(resolve);
    const { html } = await render(pageOf('/members?sort=name'));
    const markup = typeof html === 'string' ? html : await new Response(html).text();
    expect(markup).toContain('aria-sort="ascending"');
    expect(markup.match(/aria-sort=/g), 'aria-sort on a heading the table is not sorted by').toHaveLength(1);
    expect(markup).toContain('3 Mitglieder, sortiert nach Name (aufsteigend)');
    expect(markup).toContain('aria-label="Grace Hopper auswählen"');
    expect(markup).not.toMatch(/checked=""/);
  });
});

describe('useTable — in the browser', () => {
  it('sorts by the alias: a visit with ?sort=, only the table’s prop', async () => {
    await mount(pageOf('/members'));
    await click($('thead th:nth-child(3) button'));
    await until(() => expect(requests.at(-1)).toMatchObject({ url: '/members?sort=joined', headers: { [PARTIAL_DATA_HEADER]: 'members' } }));
    await until(() => expect($('thead th:nth-child(3)').getAttribute('aria-sort')).toBe('ascending'));
    expect($('thead th:nth-child(2)').hasAttribute('aria-sort')).toBe(false);
  });

  it('selects rows (the page checkbox too) and runs a bulk action with their keys — then the selection is empty and the rows gone', async () => {
    await mount(pageOf('/members'));
    const boxes = () => [...container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
    await click(boxes()[1]!);
    await until(() => expect($('[data-testid="bulk"]').textContent).toBe('1'));
    expect($<HTMLInputElement>('thead input').indeterminate).toBe(true);
    await click($('thead input'));
    await until(() => expect(boxes().every((box) => box.checked)).toBe(true));
    await click(boxes()[0]!);
    await click($('[data-testid="bulk"]'));
    await until(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(1));
    expect(requests.find((request) => request.method === 'POST')).toMatchObject({ url: '/members/_tables/members/bulk/removeLinks', headers: { [ACTION_HEADER]: 'true' }, body: { keys: [2, 3] } });
    expect($('[data-testid="bulk"]').textContent).toBe('0');
  });

  it('"all matching" sends the table’s state — never keys', async () => {
    await mount(pageOf('/members?sort=-joined'));
    await click($('[data-testid="matching"]'));
    await until(() => expect($('[data-testid="bulk"]').textContent).toBe('3'));
    expect([...container.querySelectorAll<HTMLInputElement>('tbody input')].every((box) => box.checked)).toBe(true);
    await click($('[data-testid="bulk"]'));
    await until(() => expect(requests.some((request) => request.method === 'POST')).toBe(true));
    expect(requests.find((request) => request.method === 'POST')!.body, '"all matching" sent something else than the table’s state').toEqual({ all: true, query: { sort: '-joined' } });
  });

  it('runs a row action, then reloads the table — the row is gone', async () => {
    await mount(pageOf('/members'));
    await click($('tbody tr:nth-child(2) button'));
    await until(() => expect([...container.querySelectorAll('tbody tr td:nth-child(2)')].map((cell) => cell.textContent)).toEqual(['Ada Lovelace', 'Alan Turing']));
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(['POST /members/_tables/members/actions/removeLinks', 'GET /members']);
    expect(requests[0]!.body).toEqual({ key: 2 });
  });
});

describe('toTanStack — TanStack Table v9 in manual mode over useTable', () => {
  it('renders the rows by key, sorts through the URL and selects into the entry’s selection', async () => {
    document.body.dataset.component = 'app/TanStack';
    await mount(pageOf('/members', 'app/TanStack'));
    expect([...container.querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-testid'))).toEqual(['row-1', 'row-2', 'row-3']);
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['name', 'Joined', 'links']);
    // Sorting: TanStack's toggle → the table's sort → a visit with the alias.
    await click($('[data-testid="th-joined"]'));
    await until(() => expect(requests.at(-1)?.url).toBe('/members?sort=joined'));
    await until(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(3));
    // Not sortable: nothing happens.
    const before = requests.length;
    await click($('[data-testid="th-links"]'));
    expect(requests).toHaveLength(before);
    // Selection: TanStack's row toggle → the entry's selection → TanStack's state.
    await click($('[data-testid="select-2"]'));
    await until(() => expect($('[data-testid="row-2"]').getAttribute('data-selected')).toBe('true'));
    expect($('[data-testid="row-1"]').getAttribute('data-selected')).toBe('false');
  });
});
