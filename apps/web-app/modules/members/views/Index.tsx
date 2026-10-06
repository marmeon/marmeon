import type { PageProps } from '@bespokecore/http';
import { Head, Link, useRouter, useTranslation } from '@bespokecore/react';
import { useState, type FormEvent } from 'react';
import { Pagination } from '../../../layouts/Pagination.tsx';
import type { ListMembersController } from '../controllers/ListMembersController.ts';

type Props = PageProps<ListMembersController>;

/**
 * The page's path — links by URL, not by route name (`<Link route="members.index">`): a name client code writes goes into the route
 * manifest of the app's first download, and this page must not make that any larger (W9.5). The headless `useTable` (W9.6) builds
 * these URLs itself.
 */
const PAGE = '/members';

/**
 * The members table — plain, accessible markup from the server's props (the headless `useTable` follows in W9 step 6):
 * a native `<table>` with a `<caption>`, `aria-sort` only on the sorted heading, the sort as a link in the heading, the count in a
 * live region, every checkbox and button named after its row. Without JavaScript every part works as an ordinary link or form.
 */
export default function Index({ members }: Props) {
  const t = useTranslation('members');
  const router = useRouter<ListMembersController>();
  const [selected, setSelected] = useState<readonly number[]>([]);
  const date = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeZone: 'UTC' });
  const label = (column: string) => t(`column.${column as 'name'}`);
  const total = members.page.type === 'offset' ? members.page.total : members.rows.length;
  const remove = members.actions.find((entry) => entry.name === 'removeLinks');
  const removeMany = members.bulk.find((entry) => entry.name === 'removeLinks');
  const csv = members.exports.find((entry) => entry.name === 'csv');
  const filters = Object.fromEntries(members.filters.map((entry) => [entry.name, entry]));
  const [joinedFrom = '', joinedTo = ''] = (filters.joined?.value ?? '').split('..');
  const onPage = members.rows.map((row) => row.id);
  const allOnPage = onPage.length > 0 && onPage.every((id) => selected.includes(id));

  // The table's state is the URL (the server parses it strictly): the filter form builds the query, a visit loads it.
  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams();
    const sort = members.state[members.query.sort];
    if (sort) query.set(members.query.sort, sort);
    const search = String(form.get(members.query.search) ?? '').trim();
    if (search) query.set(members.query.search, search);
    const locale = String(form.get(filters.locale!.key) ?? '');
    if (locale) query.set(filters.locale!.key, locale);
    const from = String(form.get('joined_from') ?? '');
    const to = String(form.get('joined_to') ?? '');
    if (from || to) query.set(filters.joined!.key, `${from}..${to}`);
    void router.visit(`${PAGE}${query.size > 0 ? `?${query}` : ''}`, { preserveScroll: true });
  };

  // Actions post to the table's endpoints; without JavaScript as a form (the server answers with this page again).
  const post = (event: FormEvent<HTMLFormElement>, url: string, data: Record<string, unknown>, confirm: string | undefined) => {
    event.preventDefault();
    void router.visit(url, { method: 'post', data, preserveScroll: true, ...(confirm ? { confirm } : {}) }).then(() => setSelected([]));
  };

  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      {/* Without JavaScript an ordinary GET form: the date range then goes as two fields the server does not know — apply needs JavaScript. */}
      <form method="get" role="search" onSubmit={applyFilters} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        {members.search && (
          <label>
            {t('search')}{' '}
            <input type="search" name={members.query.search} defaultValue={members.search.value} maxLength={100} />
          </label>
        )}
        {filters.locale?.type === 'select' && (
          <label>
            {t('locale')}{' '}
            <select name={filters.locale.key} defaultValue={filters.locale.value ?? ''}>
              <option value="">{t('locale_option', { locale: 'any' })}</option>
              {filters.locale.options.map((option) => (
                <option key={option} value={option}>
                  {t('locale_option', { locale: option })}
                </option>
              ))}
            </select>
          </label>
        )}
        {filters.joined && (
          <>
            <label>
              {t('joined_from')} <input type="date" name="joined_from" defaultValue={joinedFrom} />
            </label>
            <label>
              {t('joined_to')} <input type="date" name="joined_to" defaultValue={joinedTo} />
            </label>
          </>
        )}
        <button type="submit">{t('apply')}</button>
        <Link href={PAGE}>{t('reset')}</Link>
      </form>

      {/* The count, read out after every change (a live region) — with the sort, when there is one. */}
      <p role="status" aria-live="polite" data-count="">
        {members.sort && total > 0
          ? t('sorted', { total, column: label(members.sort.column), direction: members.sort.direction })
          : t('count', { total })}
      </p>

      {removeMany && (
        <form
          id="members-bulk"
          method="post"
          action={removeMany.url}
          onSubmit={(event) => post(event, removeMany.url, { keys: selected }, removeMany.confirm ? t('confirm_bulk', { count: selected.length }) : undefined)}
        >
          <button type="submit" disabled={selected.length === 0}>
            {t('bulk_remove', { count: selected.length })}
          </button>{' '}
          {total > 0 && total <= removeMany.max && (
            <button
              type="submit"
              formAction={`${removeMany.url}?${new URLSearchParams(members.state)}`}
              name="all"
              value="1"
              onClick={(event) => {
                // "All matching" is the filter state — the server parses it again; never a list of keys from here.
                event.preventDefault();
                const message = removeMany.confirm ? t('confirm_bulk', { count: total }) : undefined;
                void router
                  .visit(removeMany.url, { method: 'post', data: { all: true, query: members.state }, preserveScroll: true, ...(message ? { confirm: message } : {}) })
                  .then(() => setSelected([]));
              }}
            >
              {t('bulk_all', { total })}
            </button>
          )}
        </form>
      )}

      {members.rows.length === 0 ? (
        <p>{t('none')}</p>
      ) : (
        <table>
          <caption>{t('caption')}</caption>
          <thead>
            <tr>
              {removeMany && (
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label={t('select_page')}
                    checked={allOnPage}
                    onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...onPage])] : selected.filter((id) => !onPage.includes(id)))}
                  />
                </th>
              )}
              {members.columns.map((column) => (
                // aria-sort only on the heading the table is sorted by (WAI-ARIA APG) — never "none" on the others.
                <th key={column.name} scope="col" aria-sort={column.sort === 'asc' ? 'ascending' : column.sort === 'desc' ? 'descending' : undefined}>
                  {column.sortable ? (
                    <Link
                      href={`${PAGE}?${new URLSearchParams({ ...members.state, [members.query.sort]: column.sort === 'asc' ? `-${column.name}` : column.name })}`}
                      preserveScroll
                      aria-label={t('sort_by', { column: label(column.name) })}
                    >
                      {label(column.name)} {column.sort === 'asc' ? '▲' : column.sort === 'desc' ? '▼' : ''}
                    </Link>
                  ) : (
                    label(column.name)
                  )}
                </th>
              ))}
              {remove && <th scope="col">{t('actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {members.rows.map((row) => (
              <tr key={row.id}>
                {removeMany && (
                  <td>
                    <input
                      type="checkbox"
                      form="members-bulk"
                      name="keys[]"
                      value={row.id}
                      aria-label={t('select', { name: row.name })}
                      checked={selected.includes(row.id)}
                      onChange={(event) => setSelected(event.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))}
                    />
                  </td>
                )}
                {members.columns.map((column) => (
                  <td key={column.name}>
                    {column.name === 'joined' ? date(row.joined) : column.name === 'links' ? (row.links ?? 0) : String(row[column.name as 'name' | 'email'] ?? '')}
                  </td>
                ))}
                {remove && (
                  <td>
                    {row.can.removeLinks && (
                      <form method="post" action={remove.url} onSubmit={(event) => post(event, remove.url, { key: row.id }, remove.confirm ? t('confirm_remove', { name: row.name }) : undefined)}>
                        <input type="hidden" name="key" value={row.id} />
                        <button type="submit" aria-label={t('remove_links_of', { name: row.name })}>
                          {t('remove_links')}
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {members.page.type === 'offset' && <Pagination meta={members.page} />}
      {csv && (
        <p>
          {/* A download, not a visit: the server answers a file (no-store), with the table's sort and filters. */}
          <a href={csv.url} download data-export="">
            {t('export')}
          </a>
        </p>
      )}
    </main>
  );
}
