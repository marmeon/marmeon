import { defineGegenproben } from '../define.ts';

/**
 * W9.5 — `@bespokecore/table` on the server (E183, part 2): hidden columns neither in the props nor in the SQL, the URL parsed strictly
 * (unknown or raw sorts, filters that are none, page sizes that are none: 400), actions and bulk actions checked again on their
 * endpoints (visibility, the base query, the policy per row, the limit of "all matching"), the CSV export (formulas, hidden columns,
 * its own authorization), the encrypted cursor end to end, and the endpoints behind the page's middleware.
 *
 * Masking pairs, each with its own cases: the projection (SQL) ↔ the props filter (pick) — G1/G2 with the probes G1c/G2c; the base
 * query ↔ the policy per row in a bulk action — G7/G8 with G7c/G8c.
 */
const table = (name: string) => ({ vitest: 'packages/table/src/table.test.ts', name });
const members = (name: string) => ({ vitest: 'apps/web-app/modules/members/members.test.ts', name });
const TABLES = 'packages/table/src/tables.ts';
const STATE = 'packages/table/src/state.ts';
/** The table's endpoints registered on a registrar of their own — without the page's authenticate() and verified(). */
const ROUTES_OUTSIDE = { file: 'apps/web-app/modules/members/routes.ts', find: "  tableRoutes(members.middleware(throttle('members-table')), MembersTable);", replace: "  tableRoutes(Route.prefix('/members') as never, MembersTable);" };

/** The props filter off: a row goes to the browser as the database returned it. */
const NO_PICK = { file: TABLES, find: '  for (const [alias] of view.columns) out[alias] = row[alias];', replace: '  Object.assign(out, row);' };
/** The projection off: every defined column is selected, hidden or not. */
const NO_PROJECTION = {
  file: TABLES,
  find: '  return query.select((eb) => [...view.columns.map(([alias, col]) => eb.ref(col.ref).as(alias)),',
  replace: '  return query.select((eb) => [...Object.entries(definition.columns).map(([alias, col]) => eb.ref(col.ref).as(alias)),',
};
/** "∩ the base query" off for chosen keys: the tenant's `where` is dropped. */
const BULK_WITHOUT_BASE = {
  file: TABLES,
  find: 'await project(definition, this.#base(definition, ctx), view).where(definition.key, \'in\', usable).execute();',
  replace: 'await project(definition, this.#base(definition, ctx).clearWhere(), view).where(definition.key, \'in\', usable).execute();',
};
/** The policy per row off in bulk actions. */
const BULK_WITHOUT_POLICY = {
  file: TABLES,
  find: '    if (entry.authorization) { // the policy per row: refused rows are left out and counted',
  replace: '    if (false as boolean) { // the policy per row: refused rows are left out and counted',
};
/** The sort allowlist off — and an unknown sort goes into ORDER BY as written (the classic). */
const RAW_SORT = [
  {
    file: STATE,
    find: "    if (!Object.hasOwn(definition.columns, column) || !definition.columns[column]!.isSortable) {",
    replace: '    if (false as boolean) {',
  },
  { file: TABLES, find: '  if (state.sort && !visible.has(state.sort.column)) throw', replace: '  if (false as boolean) throw' },
  { file: TABLES, find: '    const ref = definition.columns[state.sort.column]!.ref;', replace: '    const ref = definition.columns[state.sort.column]?.ref ?? state.sort.column;' },
];

export default defineGegenproben({
  step: 'W9.5',
  cases: [
    // --- Hidden columns: the props filter ↔ the projection -----------------------------------------------------------------------
    {
      id: 'G1',
      title: 'without the props filter, a column the base query selects itself reaches the page object',
      patch: [NO_PICK],
      run: table('keeps whatever the base query selects itself on the server'),
      expect: /a hidden column reached the props/,
      masks: 'G2',
    },
    {
      id: 'G1c',
      title: 'masking probe: without the props filter, the SQL still selects no hidden column (the projection holds on its own)',
      patch: [NO_PICK],
      run: table('does not select a hidden column'),
      expectGreen: true,
    },
    {
      id: 'G2',
      title: 'without the projection, the SQL selects the hidden column (the query log)',
      patch: [NO_PROJECTION],
      run: table('does not select a hidden column'),
      expect: /the SQL selects a hidden column/,
      masks: 'G1',
    },
    {
      id: 'G2c',
      title: 'masking probe: without the projection, the props still carry no hidden column (the props filter holds on its own)',
      patch: [NO_PROJECTION],
      run: table('sends the visible columns only'),
      expectGreen: true,
    },
    {
      id: 'G2b',
      title: 'the same in the app: without the projection, the members page selects the e-mail for a member',
      patch: [NO_PROJECTION],
      run: members('shows the e-mail column to administrators only'),
      expect: /the SQL selects a hidden column/,
    },

    // --- The URL, strictly -------------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'sort=unknown: without the allowlist the raw name goes into ORDER BY — no 400',
      patch: RAW_SORT,
      run: table('an unknown sort → 400'),
      expect: /sort=unknown answered 500/,
    },
    {
      id: 'G4',
      title: 'sort=password (a raw column): without the allowlist the table sorts by the secret column — 200',
      patch: RAW_SORT,
      run: table('a raw column name → 400'),
      expect: /sort=password answered 200/,
    },
    {
      id: 'G4b',
      title: 'the same in the app: /members?sort=password is answered',
      patch: RAW_SORT,
      run: members('sorts and filters by the URL'),
      expect: /sort=password answered 200/,
    },
    {
      id: 'G5',
      title: 'filter[password]=x: without the filter allowlist the raw column goes into WHERE',
      patch: [
        { file: STATE, find: '    if (!found) throw new TableQueryError(`${key}: the table "${definition.name}" has no such filter.`);', replace: '    if (!found) return value;' },
        { file: TABLES, find: '  for (const name of Object.keys(state.filters)) if (!filters.has(name)) throw', replace: '  for (const name of Object.keys(state.filters)) if (false as boolean) throw' },
        { file: TABLES, find: '      const entry = definition.filters[name]!;', replace: "      const entry = definition.filters[name] ?? { type: 'select', ref: name };" },
      ],
      run: table('a filter that is none → 400'),
      expect: /filter\[password\]=x answered 200/,
    },
    {
      id: 'G6',
      title: 'per_page=10000: without the list of sizes the table hands out every row',
      patch: [{ file: STATE, find: '    if (!/^\\d{1,4}$/.test(value) || !definition.perPage.includes(size)) throw', replace: '    if (false as boolean) throw' }],
      run: table('a page size the table does not offer → 400'),
      expect: /per_page=10000 answered 200/,
    },
    {
      id: 'G6b',
      title: 'a hidden column is sortable when the state is not checked against what is visible (its order tells its values)',
      patch: [{ file: TABLES, find: '  if (state.sort && !visible.has(state.sort.column)) throw', replace: '  if (false as boolean) throw' }],
      run: table('a hidden column cannot be sorted by'),
      expect: /a hidden column was sortable/,
    },

    // --- Actions: everything again on the endpoint -------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'a row action hidden by its policy runs through its endpoint without the second check',
      patch: [{ file: TABLES, find: 'throw forbidden(); // a hidden action: refused when called directly too', replace: 'void forbidden(); // a hidden action: refused when called directly too' }],
      run: table('checks the action\'s visibility again'),
      expect: /a hidden action ran/,
    },
    {
      id: 'G7b',
      title: 'the same for a bulk action',
      patch: [{ file: TABLES, find: 'throw forbidden(); // a hidden bulk action: refused when called directly too', replace: 'void forbidden(); // a hidden bulk action: refused when called directly too' }],
      run: table('is hidden from who may not see it'),
      expect: /a hidden bulk action ran/,
    },
    {
      id: 'G8',
      title: 'a row action without the policy asked again: a row the page showed as refused runs',
      patch: [{ file: TABLES, find: '      if (!allowed) throw forbidden();', replace: '      if (false as boolean) throw forbidden();' }],
      run: table('asks the policy again'),
      expect: /the policy was not asked again/,
    },
    {
      id: 'G8b',
      title: 'a row action without the base query: another team’s row is acted on',
      patch: [
        {
          file: TABLES,
          find: "    const found = await project(definition, this.#base(definition, ctx), view).where(definition.key, '=', key)",
          replace: "    const found = await project(definition, this.#base(definition, ctx).clearWhere(), view).where(definition.key, '=', key)",
        },
      ],
      run: table('looks the row up in the base query'),
      expect: /a key of another team was acted on/,
    },

    // --- Bulk: the base query ↔ the policy per row -------------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'bulk keys of another team are acted on without “∩ the base query”',
      patch: [BULK_WITHOUT_BASE],
      run: table('keys ∩ the base query'),
      expect: /a key outside the base query was acted on/,
      masks: 'G10',
    },
    {
      id: 'G9c',
      title: 'masking probe: without “∩ the base query”, the policy per row still refuses its rows',
      patch: [BULK_WITHOUT_BASE],
      run: table('∩ the policy per row'),
      expectGreen: true,
    },
    {
      id: 'G10',
      title: 'rows of the table the policy refuses are acted on (not skipped, not counted) without the policy per row',
      patch: [BULK_WITHOUT_POLICY],
      run: table('∩ the policy per row'),
      expect: /a row the policy refuses was acted on/,
      masks: 'G9',
    },
    {
      id: 'G10c',
      title: 'masking probe: without the policy per row, keys outside the base query are still left out',
      patch: [BULK_WITHOUT_POLICY],
      run: table('keys ∩ the base query'),
      expectGreen: true,
    },
    {
      id: 'G11',
      title: '“all matching” over the limit runs (on the first max + 1 rows) without the check',
      patch: [{ file: TABLES, find: '      if (found.length > entry.limit) {', replace: '      if (false as boolean) {' }],
      run: table('refuses more rows than its max'),
      expect: /more matching rows than max were acted on/,
    },

    // --- The export ----------------------------------------------------------------------------------------------------------------
    {
      id: 'G12',
      title: 'a CSV cell =HYPERLINK(…) goes out as a formula without the escaping',
      patch: [{ file: 'packages/table/src/csv.ts', find: "  else if (typeof value === 'string') text = FORMULA_START.test(value) ? `'${value}` : value;", replace: "  else if (typeof value === 'string') text = value;" }],
      run: table('escapes formulas (OWASP)'),
      expect: /a formula reached the CSV/,
    },
    {
      id: 'G12b',
      title: 'the same in the app: the members export',
      patch: [{ file: 'packages/table/src/csv.ts', find: "  else if (typeof value === 'string') text = FORMULA_START.test(value) ? `'${value}` : value;", replace: "  else if (typeof value === 'string') text = value;" }],
      run: members('downloads the list as CSV'),
      expect: /a formula reached the CSV/,
    },
    {
      id: 'G13',
      title: 'the export carries the hidden column when it takes every column of the definition',
      patch: [
        {
          file: TABLES,
          find: '    const view = await this.#view(definition, ctx); // the export\'s columns: the visible ones',
          replace: '    const view = { ...(await this.#view(definition, ctx)), columns: Object.entries(definition.columns) }; // the export\'s columns: the visible ones',
        },
      ],
      run: table('leaves a hidden column out'),
      expect: /a hidden column reached the export/,
    },
    {
      id: 'G14',
      title: 'an export without its own authorization: whoever sees the table downloads it',
      patch: [{ file: TABLES, find: 'throw forbidden(); // the export\'s own authorization', replace: 'void forbidden(); // the export\'s own authorization' }],
      run: table('has its own authorization'),
      expect: /the export ran without its authorization/,
    },

    // --- The cursor, end to end ----------------------------------------------------------------------------------------------------
    {
      id: 'G15',
      title: 'a changed cursor is taken (page 1 again) when one that does not decrypt is not refused',
      patch: [
        {
          file: 'packages/database/src/pagination.ts',
          find: '    if (!after) throw new InvalidCursorError();\n    page = page.where((eb) => rowsAfter(eb, columns, after, direction));',
          replace: '    if (after) page = page.where((eb) => rowsAfter(eb, columns, after, direction));',
        },
      ],
      run: table('pages by an encrypted cursor when asked to'),
      expect: /a changed cursor was taken/,
    },

    // --- The page's middleware -----------------------------------------------------------------------------------------------------
    {
      id: 'G16',
      title: 'endpoints registered outside the page’s registrar (no verified()): an unconfirmed administrator runs a table action',
      patch: [ROUTES_OUTSIDE],
      run: members('an unconfirmed account never reaches the table'),
      expect: /an unconfirmed account ran a table action/,
    },
    {
      id: 'G16b',
      // Honest: the policies still refuse a guest (403) — the middleware decides how (401, the login page), not whether.
      title: 'the same for a guest: without authenticate() the action is a 403 of the policy instead of the 401 that signs in',
      patch: [ROUTES_OUTSIDE],
      run: members('a guest never reaches the page or the table'),
      expect: /a guest was not sent to sign in by the action/,
    },
    // --- Follow-up (06.10.): keys by type, the export's limit and its transaction boundary, the app's throttle ----------------------
    {
      id: 'G17',
      title: 'without parsing by the key type, text reaches the integer key column (Postgres: a 500)',
      patch: [{ file: TABLES, find: '    const key = parseKey(definition.keyType, body.key);', replace: '    const key = body.key as string | number;' }],
      run: table('an integer key never sends text to the database'),
      expect: /text reached an integer key column/,
    },
    {
      id: 'G18',
      title: 'an export over its limit is streamed (the whole filtered table) without the limit',
      patch: [{ file: TABLES, find: '    if (Number(count) > entry.limit) {', replace: '    if (false as boolean) {' }],
      run: table('refuses an export over its limit'),
      expect: /an export over its limit was streamed/,
    },
    {
      id: 'G19',
      title: 'later export batches run in the transaction the handler answered in — finished by then: the stream breaks',
      patch: [{ file: TABLES, find: '        const rows = await inRequest(() => outsideTransaction(() => batch(offset)));', replace: '        const rows = await inRequest(() => batch(offset));' }],
      run: table('streams its later batches outside the transaction'),
      expect: /a later batch ran in the finished transaction/,
    },
    {
      id: 'G20',
      title: 'the members table’s endpoints without the throttle: the 61st export of a minute is served',
      patch: [{ file: 'apps/web-app/modules/members/routes.ts', find: "  tableRoutes(members.middleware(throttle('members-table')), MembersTable);", replace: '  tableRoutes(members, MembersTable);' }],
      run: members('throttles the table'),
      expect: /the 61st request of a minute was served/,
    },
  ],
});
