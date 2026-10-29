import type { PageProps } from '@marmeon/http';
import { FileInput, Form, Head, Link, useFlash, useForm, useTranslation } from '@marmeon/react';
import { useTable, type TableRunOutcome } from '@marmeon/react/table';
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Pagination } from '../../../layouts/Pagination.tsx';
import type { ListMembersController } from '../controllers/ListMembersController.ts';

type Props = PageProps<ListMembersController>;

/**
 * The page's path — links by URL, not by route name (`<Link route="members.index">`): a name client code writes goes into the route
 * manifest of the app's first download, and the page's links must not make that any larger. (The import form is the exception: a
 * form with an upload field needs its route name, because `form.field()` and `<FileInput>` exist only on a route's form.)
 */
const PAGE = '/members';

/**
 * The members table on the headless `useTable`: a native `<table>` with a `<caption>`, `aria-sort` only on the sorted heading,
 * the sort as a link in the heading, the member's name as each row's header, the list's count (and page) in a live region and what an
 * action did in another, every checkbox and button named after its row — the name starting with the button's visible text (WCAG
 * 2.5.3). Sorting, filtering and paging are visits of the page's URL; the selection lives with the history entry; actions are action
 * requests, after which the table reloads. Controls stay where they are while something runs (`aria-disabled`, never `disabled`:
 * focus is never dropped). Without JavaScript every part still works as an ordinary link or form.
 */
export default function Index({ members }: Props) {
  const t = useTranslation('members');
  // The import: a text file uploaded ahead (`upload({ text: true })` — a CSV in any common encoding; HTML, SVG and binary files are
  // refused by their bytes); the form sends the token. Administrators only: the export link below marks them.
  const importForm = useForm('members.import', { file: null });
  const file = importForm.data.file;
  // The preview keeps the file and its toast carries the id: the second step posts it to the confirmation. The next toast replaces it.
  const [kept, setKept] = useState<string | undefined>();
  useFlash('toast', (toast) => setKept(toast.confirm));
  const label = (column: string) => t(`column.${column as 'name'}`);
  const table = useTable(members, {
    labels: {
      column: label,
      row: (row) => row.name,
      status: ({ total, shown, sort, page }) =>
        (sort && (total ?? shown) > 0 ? t('sorted', { total: total ?? shown, column: sort.label, direction: sort.direction }) : t('count', { total: total ?? shown })) +
        (page ? t('page_of', page) : ''),
      select: (name) => t('select', { name }),
      selectPage: () => t('select_page'),
      action: (_action, name) => t('remove_links_of', { name }),
      confirm: (_action, count) => t('confirm_bulk', { count }),
    },
  });
  // What the last action did — read out in a live region of its own (the list's count may not change at all).
  const [notice, setNotice] = useState('');
  const date = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeZone: 'UTC' });
  const total = table.page.type === 'offset' ? table.page.total : table.rows.length;
  const remove = table.actions.find((entry) => entry.name === 'removeLinks');
  const removeMany = table.bulk.find((entry) => entry.name === 'removeLinks');
  const setLocale = table.bulk.find((entry) => entry.name === 'setLocale');
  const csv = table.exports.find((entry) => entry.name === 'csv');
  const filters = Object.fromEntries(table.filters.map((entry) => [entry.name, entry]));
  const [joinedFrom = '', joinedTo = ''] = (filters.joined?.value ?? '').split('..');
  // The form's fields are the page's state: after "Reset" or Back (the page stays mounted) they show it again. The others are new
  // fields per state (their `key`); the search field follows unless it is being typed into — its own visits bring what was typed.
  const searchValue = table.search?.value ?? '';
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const field = searchField.current;
    if (field && field !== document.activeElement && field.value !== searchValue) field.value = searchValue;
  }, [searchValue]);

  // "Apply": the page size and every filter of the form — the URL is the table's state, the server parses it strictly.
  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const size = Number(form.get(members.query.perPage));
    if (size !== table.page.perPage) table.perPage(size);
    const from = String(form.get('joined_from') ?? '');
    const to = String(form.get('joined_to') ?? '');
    table.filterBy({ locale: String(form.get(filters.locale?.key ?? '') ?? '') || null, joined: from || to ? `${from}..${to}` : null });
  };

  const report = (outcome: TableRunOutcome) => {
    if (outcome.kind === 'cancelled') return;
    setNotice(outcome.kind === 'data' ? t('removed', { done: outcome.data.done, skipped: outcome.data.skipped + outcome.data.missing }) : t('remove_failed'));
  };
  const reportLocale = (outcome: TableRunOutcome) => {
    if (outcome.kind === 'cancelled') return;
    setNotice(outcome.kind === 'data' ? t('locale_set', { done: outcome.data.done, skipped: outcome.data.skipped + outcome.data.missing }) : t('locale_set_failed'));
  };
  /** A control that cannot be used right now stays focusable (aria-disabled) — a click does nothing. */
  const unless = (blocked: boolean, run: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!blocked) run();
  };

  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      {/* Without JavaScript an ordinary GET form: the date range then goes as two fields the server does not know — apply needs JavaScript. */}
      <form method="get" role="search" onSubmit={applyFilters} className="filters">
        {table.search && (
          <label>
            {t('search')}{' '}
            {/* Searches as you type (after a pause; one history entry for it). */}
            <input ref={searchField} type="search" name={members.query.search} defaultValue={table.search.value} maxLength={100} onChange={(event) => table.setSearch(event.target.value.trim())} />
          </label>
        )}
        {filters.locale?.type === 'select' && (
          <label>
            {t('locale')}{' '}
            <select key={filters.locale.value ?? ''} name={filters.locale.key} defaultValue={filters.locale.value ?? ''}>
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
              {t('joined_from')} <input key={joinedFrom} type="date" name="joined_from" defaultValue={joinedFrom} />
            </label>
            <label>
              {t('joined_to')} <input key={joinedTo} type="date" name="joined_to" defaultValue={joinedTo} />
            </label>
          </>
        )}
        {table.page.perPageOptions.length > 1 && (
          <label>
            {t('per_page')}{' '}
            <select key={table.page.perPage} name={members.query.perPage} defaultValue={table.page.perPage}>
              {table.page.perPageOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit">{t('apply')}</button>
        <Link href={PAGE}>{t('reset')}</Link>
      </form>

      {/* The count (and page), read out after every change of the list — with the sort, when there is one. "None match" is said here. */}
      <p {...table.statusProps} data-count="">
        {table.status}
      </p>

      {table.rows.length > 0 && (
        <table>
          <caption>{t('caption')}</caption>
          <thead>
            <tr>
              {removeMany && (
                <th scope="col">
                  <input {...table.pageCheckboxProps()} />
                </th>
              )}
              {table.columns.map((column) => (
                // aria-sort only on the heading the table is sorted by (WAI-ARIA APG) — never "none" on the others.
                <th key={column.name} {...column.headerProps}>
                  {column.sortLinkProps ? (
                    <a {...column.sortLinkProps}>
                      {column.label}
                      <span aria-hidden="true">{column.sort === 'asc' ? ' ▲' : column.sort === 'desc' ? ' ▼' : ''}</span>
                    </a>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
              {remove && <th scope="col">{t('actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.id}>
                {removeMany && (
                  <td>
                    <input {...table.checkboxProps(row)} form="members-bulk" name="keys[]" value={row.id} />
                  </td>
                )}
                {table.columns.map((column) =>
                  // The member's name heads the row: moving down a column, a screen reader says whose value it is.
                  column.name === 'name' ? (
                    <th key={column.name} scope="row">
                      {row.name}
                    </th>
                  ) : (
                    <td key={column.name}>{column.name === 'joined' ? date(row.joined) : column.name === 'links' ? row.links : String(row.email ?? '')}</td>
                  ),
                )}
                {remove && (
                  <td>
                    {table.can('removeLinks', row) && (
                      <form method="post" action={remove.url}>
                        <input type="hidden" name="key" value={row.id} />
                        <button
                          type="submit"
                          aria-label={table.actionLabel('removeLinks', row)}
                          aria-disabled={table.pending || undefined}
                          onClick={unless(table.pending, () => void table.run('removeLinks', row, { confirm: t('confirm_remove', { name: row.name }) }).then(report))}
                        >
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

      {/* After the table: where the rows were ticked. The buttons stay (aria-disabled) — a click on one that cannot run does nothing. */}
      {removeMany && table.rows.length > 0 && (
        <form id="members-bulk" method="post" action={removeMany.url}>
          <button
            type="submit"
            aria-disabled={table.selectedCount === 0 || table.pending || undefined}
            onClick={unless(table.selectedCount === 0 || table.pending, () => void table.runBulk('removeLinks').then(report))}
          >
            {t('bulk_remove', { count: table.selectedCount })}
          </button>{' '}
          {total <= removeMany.max && (
            <button
              type="submit"
              formAction={`${removeMany.url}?${new URLSearchParams(members.state)}`}
              name="all"
              value="1"
              aria-disabled={table.pending || undefined}
              onClick={unless(table.pending, () => {
                // "All matching" is the filter state — the server parses it again; never a list of keys from here.
                table.selectMatching();
                void table.runBulk('removeLinks').then(report);
              })}
            >
              {t('bulk_all', { total })}
            </button>
          )}{' '}
          <button type="button" aria-disabled={table.selectedCount === 0 || undefined} onClick={unless(table.selectedCount === 0, () => table.clearSelection())}>
            {t('select_none')}
          </button>
          {/* Only the clicked button's name and value are posted, so the form's other buttons never send an `input`. */}
          {setLocale &&
            (['en', 'de'] as const).map((option) => (
              <button
                key={option}
                type="submit"
                formAction={setLocale.url}
                name="input[locale]"
                value={option}
                aria-disabled={table.selectedCount === 0 || table.pending || undefined}
                onClick={unless(table.selectedCount === 0 || table.pending, () => void table.runBulk('setLocale', { input: { locale: option } }).then(reportLocale))}
              >
                {t('set_locale_button', { count: table.selectedCount, locale: option })}
              </button>
            ))}
        </form>
      )}
      <p role="status" aria-live="polite" data-notice="">
        {notice}
      </p>

      {table.page.type === 'offset' && <Pagination meta={table.page} />}
      {csv && (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void importForm.submit();
          }}
        >
          <p>
            <label htmlFor="members-import">{t('import_file')}</label>{' '}
            <FileInput id="members-import" field={importForm.field('file')} accept=".csv,.txt,text/csv,text/plain" aria-invalid={!!(importForm.errors.file ?? file?.error)} aria-describedby="members-import-status" />{' '}
            <button type="submit" disabled={file?.status !== 'uploaded' || importForm.processing}>
              {t('import_save')}
            </button>
          </p>
          <p id="members-import-status" aria-live="polite">
            {file?.uploading && <small>{t('import_uploading', { percent: Math.round(file.progress * 100) })}</small>}
            {file?.status === 'uploaded' && <small>{t('import_ready')}</small>}
            {(importForm.errors.file ?? file?.error) && <small role="alert">{importForm.errors.file ?? file?.error}</small>}
          </p>
        </form>
      )}
      {kept !== undefined && (
        <Form route="members.import.confirm" params={{ import: kept }}>
          <button type="submit">{t('import_confirm')}</button>
        </Form>
      )}
      {csv && (
        <p>
          {/* A download, not a visit: the server answers a file (no-store), with the table's sort and filters. */}
          <a href={table.exportUrl('csv')} download data-export="">
            {t('export')}
          </a>
        </p>
      )}
    </main>
  );
}
