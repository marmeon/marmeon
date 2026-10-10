import { defineGegenproben } from '../define.ts';

/**
 * W9.3 — merge, query and pagination frozen (E183, part 1): a revalidation (an action's reload, a live hint's) replaces merged props
 * while "load more" appends, GET lists as repeated keys, `paginate(ctx.query)` with `pageQuery()`, `<Pagination>` from the parsed query
 * and in German, encrypted cursors (a NULL is a cursor, a forged one a 400), `merge()` of a paginator, paths in `matchOn`, merge marks
 * that do not pile up, and `useQueryState.set()` before its effect. The action path and the live path are separate cases (one could
 * hide the other); so are the cursor's checks (encryption, the 400, the NULLs, its order). G10 (paginationFrom() and a parsed query) is
 * retired with paginationFrom() itself (W12 step 4b).
 */
const merge = (name: string) => ({ vitest: 'packages/http/src/client/merge.test.ts', name });
const pagination = (name: string) => ({ vitest: 'packages/database/src/pagination.test.ts', name });
const RESET_OF = { file: 'packages/http/src/client/merge.ts', find: '  return spec.reset ?? true;', replace: '  return spec.reset ?? [];' };

export default defineGegenproben({
  step: 'W9.3',
  cases: [
    // --- A revalidation replaces, load more appends ----------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'an action’s reload merges into a merge()d list: the row it deleted comes back from the pages loaded before',
      patch: [RESET_OF],
      run: merge('an action’s reload: the row it deleted stays gone'),
      expect: /the deleted row came back/,
      masks: 'G2',
    },
    {
      id: 'G1b',
      title: 'the same through React: useAction + router.reloading() on a list that loaded more',
      patch: [RESET_OF],
      run: { vitest: 'packages/react/src/use-action.test.tsx', name: 'a row deleted from a merge()d list that loaded more stays gone' },
      expect: /the deleted row came back/,
    },
    {
      id: 'G1c',
      title: 'masking probe: without the revalidations’ reset, a live hint still replaces (its own path)',
      patch: [RESET_OF],
      run: merge('a live hint’s reload: the row deleted in another tab is gone'),
      expectGreen: true,
    },
    {
      id: 'G2',
      title: 'a live hint’s reload merges: the row deleted in another tab comes back',
      patch: [
        {
          file: 'packages/http/src/client/features/live.ts',
          find: 'reload: (only) => host.navigator.reload({ only, reset: only, async: true })',
          replace: 'reload: (only) => host.navigator.reload({ only, async: true })',
        },
      ],
      run: merge('a live hint’s reload: the row deleted in another tab is gone'),
      expect: /the deleted row came back/,
      masks: 'G1',
    },
    {
      id: 'G2c',
      title: 'masking probe: without the live hint’s reset, an action’s reload still replaces (its own path)',
      patch: [
        {
          file: 'packages/http/src/client/features/live.ts',
          find: 'reload: (only) => host.navigator.reload({ only, reset: only, async: true })',
          replace: 'reload: (only) => host.navigator.reload({ only, async: true })',
        },
      ],
      run: merge('an action’s reload: the row it deleted stays gone'),
      expectGreen: true,
    },
    {
      id: 'G3',
      title: 'reset everywhere (a heuristic instead of the origin): load more after a revalidation replaces the list',
      patch: [{ file: 'packages/http/src/client/merge.ts', find: '    if (reset === true || reset.includes(key)) props[key] = value;', replace: '    if (true) props[key] = value;' }],
      run: merge('load more after a revalidation appends again'),
      expect: /load more replaced the list/,
    },
    {
      id: 'G4',
      title: 'a layer’s revalidation merges: the deleted row comes back in the layer',
      patch: [{ file: 'packages/http/src/client/features/layers.ts', find: ': loaded.props }, resetOf(spec))', replace: ': loaded.props })' }],
      run: merge('a layer’s revalidation replaces its merged props too'),
      expect: /the deleted row came back/,
    },
    {
      id: 'G5',
      title: 'an island’s revalidation merges: the deleted row comes back in the island',
      patch: [{ file: 'packages/http/src/client/region.ts', find: 'except: spec.except, reset: resetOf(spec) }', replace: 'except: spec.except }' }],
      run: merge('an island’s revalidation'),
      expect: /the deleted row came back/,
    },
    // --- merge() ---------------------------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'merge() of a paginator replaces its data instead of appending it',
      patch: [
        {
          file: 'packages/http/src/client/merge.ts',
          find: '      if (Array.isArray(current.data) && Array.isArray(next.data)) merged.data = append(current.data, next.data, matchKey(`${path}.data`, match));\n',
          replace: '',
        },
      ],
      run: merge('merge() merges a paginator by its data'),
      expect: /the paginator’s data was replaced/,
    },
    {
      id: 'G7',
      title: 'matchOn takes a key right at the items only: a path into them (user.id) matches nothing — appended twice',
      patch: [
        {
          file: 'packages/http/src/client/merge.ts',
          find: "key.split('.').reduce<unknown>((value, part) => (isPlainObject(value) ? value[part] : undefined), item)",
          replace: '(isPlainObject(item) ? item[key] : undefined)',
        },
      ],
      run: merge('matches on a path into each item'),
      expect: /not matched on the path/,
    },
    {
      id: 'G8',
      title: 'mergeProps pile up over reloads: a prop the server no longer merges stays marked',
      patch: [{ file: 'packages/http/src/client/merge.ts', find: "(current[name] ?? []).filter((entry) => !arrived.includes(entry.split('.', 1)[0]!))", replace: '(current[name] ?? [])' }],
      run: merge('it never piles up over reloads'),
      expect: /expected \[ 'a', 'b' \] to deeply equal \[ 'b' \]/,
    },
    // --- GET lists ---------------------------------------------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'a list in a GET’s data is joined with commas: ?role=admin%2Cowner',
      patch: [
        {
          file: 'packages/http/src/client/request.ts',
          find: '        for (const item of [value].flat()) if (item !== undefined && item !== null) target.searchParams.append(key, String(item));',
          replace: '        target.searchParams.set(key, String(value));',
        },
      ],
      run: merge('a list is the key repeated'),
      expect: /the list went as one value/,
    },
    // --- Pagination from the query schema ------------------------------------------------------------------------------------------
    // G10 retired (W12 step 4b, E216): paginationFrom() is gone — pageQuery() and the parsed query are the only way to a page.
    {
      id: 'G11',
      title: 'paginate(ctx.query) ignores per_page — what pageQuery() parses',
      patch: [{ file: 'packages/database/src/pagination.ts', find: 'perPage: request.per_page ?? request.perPage', replace: 'perPage: request.perPage' }],
      run: pagination('pages by ctx.query: what pageQuery() parses'),
      expect: /to match object \{ page: 2, perPage: 5 \}/,
    },
    {
      id: 'G12',
      title: '<Pagination> in German: the web app passes no translation (its own words) — English on a German page',
      patch: [{ file: 'apps/web-app/layouts/Pagination.tsx', find: '    <Pages\n      {...props}\n      labels=', replace: '    <Pages\n      {...props}\n      data-labels=' }],
      run: { vitest: 'apps/web-app/modules/user-profile/ssr.test.ts', name: 'speak the reader’s language' },
      expect: /the page links are not German/,
    },
    {
      id: 'G13',
      title: '<Pagination> parses the address (E55) instead of taking the parsed query',
      patch: [{ file: 'packages/react/src/pagination.tsx', find: '  if (page.queryDefaults) {', replace: '  if (false) {' }],
      run: { vitest: 'packages/react/src/server.test.tsx', name: 'takes its links from the parsed query' },
      expect: /the links parsed the address/,
    },
    // --- Cursors ------------------------------------------------------------------------------------------------------------------
    {
      id: 'G14',
      title: 'a NULL in the sort column is no cursor: "load more" starts at page 1 again, forever',
      patch: [
        {
          file: 'packages/database/src/pagination.ts',
          find: '      continue; // nothing is after a NULL in this column (NULLs come last): only the next columns go on',
          replace: '      return sql<SqlBool>`1 = 1`;',
        },
      ],
      run: pagination('pages by a nullable column'),
      expect: /paging never ends: a NULL cursor starts over/,
    },
    {
      id: 'G15',
      title: 'a cursor that does not decrypt is taken as none — page 1 instead of a 400',
      patch: [{ file: 'packages/database/src/pagination.ts', find: '    if (!after) throw new InvalidCursorError();\n    page = page.where', replace: '    if (after)\n    page = page.where' }],
      run: pagination('a cursor that was changed, made up, of the old format'),
      expect: /was taken/,
    },
    {
      id: 'G15b',
      title: 'the same through the web app: a forged cursor of the notifications is a 200, not a 400',
      patch: [{ file: 'packages/database/src/pagination.ts', find: '    if (!after) throw new InvalidCursorError();\n    page = page.where', replace: '    if (after)\n    page = page.where' }],
      run: { vitest: 'apps/web-app/modules/notifications/notifications.test.ts', name: 'loads more: ten at a time by an encrypted cursor' },
      expect: /400/,
    },
    {
      id: 'G16',
      title: 'the cursor as base64url of the last row (the format before Wave 9): a hidden sort column’s value readable',
      patch: [
        {
          file: 'packages/database/src/pagination.ts',
          find: 'nextCursor: next ? await encrypter.encrypt(JSON.stringify(next), context) : null',
          replace: "nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null",
        },
      ],
      run: pagination('encrypts the cursor: no value of the last row can be read from it'),
      expect: /the cursor shows the last row/,
    },
    {
      id: 'G17',
      title: 'cursorPaginate orders behind the query’s own order (orderBy appended): the cursor follows another order',
      patch: [{ file: 'packages/database/src/pagination.ts', find: '  let page = (query as SelectQueryBuilder<any, any, O>).clearOrderBy();', replace: '  let page = query as SelectQueryBuilder<any, any, O>;' }],
      run: pagination('orders by its own columns only'),
      expect: /the query’s order came first/,
    },
    {
      id: 'G18',
      title: 'no key as the last order: rows with the same name are skipped across a page boundary',
      patch: [{ file: 'packages/database/src/pagination.ts', find: '  const columns = sorted.at(-1) === key ? sorted : [...sorted.filter((name) => name !== key), key];', replace: '  const columns = sorted;' }],
      run: pagination('pages by a column that is not unique'),
      expect: /to have a length of 15/,
    },
    // --- useQueryState -----------------------------------------------------------------------------------------------------------
    {
      id: 'G19',
      title: 'useQueryState: a set() before the state exists (a child’s effect) is dropped',
      patch: [{ file: 'packages/react/src/use-query-state.ts', find: '    else early.current.push(update);', replace: '    else void update;' }],
      run: { vitest: 'packages/react/src/use-query-state.test.tsx', name: 'a set() before the state exists' },
      expect: /the early set\(\) was dropped/,
    },
  ],
});
