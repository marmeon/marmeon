import { defineGegenproben } from '../define.ts';

/**
 * W9.6 — the headless table (E183, E186): the row selection in a slot of the history entry (the core empties it with the entry and the
 * document), sorts by the props' aliases only, "all matching" as the table's state, a table's run replacing merged rows (W9.3's reset),
 * `aria-sort` on the sorted heading only, and the table and TanStack only in bundles that import them. The leak cases patch `dist/`
 * (the size test measures it): run `pnpm build` first.
 */
const tableCore = (name: string) => ({ vitest: 'packages/table/src/client/table.test.ts', name });
const reactTable = (name: string) => ({ vitest: 'packages/react/src/table.test.tsx', name });
const matrix = (name: string) => ({ vitest: 'packages/http/src/client/security-matrix.test.ts', name });
const leak = (name: string) => ({ vitest: 'packages/react/src/bundle-size.test.ts', name: `an app holds only the features it uses (E75: leak test) > ${name}` });

const SELECTIONS_KEPT = {
  file: 'packages/http/src/client/features/selection.ts',
  find: '    for (const selection of tables.values()) selection.clear();\n    tables.clear();\n',
  replace: '    void tables;\n',
};
const RESET_OF = { file: 'packages/http/src/client/merge.ts', find: '  return spec.reset ?? true;', replace: '  return spec.reset ?? [];' };
const ALL_AS_KEYS = {
  file: 'packages/table/src/client/table.ts',
  find: 'const body = selected.matching ? { all: true, query: data.state } : { keys: selected.keys };',
  replace: 'const body = { keys: selected.matching ? this.#keys() : selected.keys };',
};
const ARIA_SORT_NONE = {
  file: 'packages/react/src/table.ts',
  find: "headerProps: column.sort === null ? { scope: 'col' } : { scope: 'col', 'aria-sort': column.sort === 'asc' ? 'ascending' : 'descending' },",
  replace: "headerProps: { scope: 'col', 'aria-sort': column.sort === 'asc' ? 'ascending' : column.sort === 'desc' ? 'descending' : ('none' as never) },",
};

export default defineGegenproben({
  step: 'W9.6',
  cases: [
    // --- The selection: a slot the core empties ----------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the selection survives a 409 (signed out): its slot keeps the keys the signed-in user ticked',
      patch: [SELECTIONS_KEPT],
      run: matrix('a 409 (signed out) leaves nothing of it'),
      expect: /selection: its slot "selections"/,
    },
    {
      id: 'G1b',
      title: 'the selection survives memory letting go of its entry (LRU)',
      patch: [SELECTIONS_KEPT],
      run: matrix('memory letting go of an entry (LRU)'),
      expect: /selection: its slot "selections"/,
    },
    // --- What goes out: aliases, the table's state -----------------------------------------------------------------------------
    {
      id: 'G2',
      title: 'a sort visit with a database column instead of an alias of the props (no check against the props)',
      patch: [
        { file: 'packages/table/src/client/table.ts', find: '    if (!found?.sortable) {\n      refuse(', replace: '    if (false as boolean) {\n      refuse(' },
        { file: 'packages/table/src/client/table.ts', find: "    const next = direction ?? (found.sort === 'asc' ? 'desc' : 'asc');\n    this.#set({ [data.query.sort]: sortValue(found.name, next)", replace: "    const next = direction ?? (found?.sort === 'asc' ? 'desc' : 'asc');\n    this.#set({ [data.query.sort]: sortValue(String(column), next)" },
      ],
      run: tableCore('never sends a sort the props do not offer'),
      expect: /a sort the props do not offer went out/,
    },
    {
      id: 'G3',
      title: '"select all matching" sends the keys on screen instead of the table’s state',
      patch: [ALL_AS_KEYS],
      run: tableCore('a bulk action sends the keys ticked'),
      expect: /"all matching" sent something else than the table’s state/,
    },
    {
      id: 'G3b',
      title: 'the same through React (useTable)',
      patch: [ALL_AS_KEYS],
      run: reactTable('"all matching" sends the table’s state'),
      expect: /"all matching" sent something else than the table’s state/,
    },
    // --- A run replaces (W9.3) ---------------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'without the revalidations’ reset (W9.3) a bulk action’s reload merges: the removed rows come back',
      patch: [RESET_OF],
      run: tableCore('a bulk action sends the keys ticked'),
      expect: /the removed rows came back/,
    },
    {
      id: 'G4b',
      title: 'the same for a row action',
      patch: [RESET_OF],
      run: tableCore('runs a row action as an action request'),
      expect: /the removed row came back/,
    },
    // --- Accessible markup -------------------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'aria-sort="none" on the headings the table is not sorted by',
      patch: [ARIA_SORT_NONE],
      run: reactTable('puts aria-sort on the sorted heading only'),
      expect: /aria-sort on a heading the table is not sorted by/,
    },
    {
      id: 'G5b',
      title: 'the same in the web app’s server-rendered page',
      patch: [ARIA_SORT_NONE],
      run: { vitest: 'apps/web-app/modules/members/members.test.ts', name: 'renders accessible markup' },
      expect: /aria-sort on a heading the table is not sorted by/,
    },
    // --- Only with its import (dist/) --------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'useTable in an app without tables: createBespokeApp’s module imports it',
      patch: [
        {
          file: 'packages/react/dist/client.js',
          find: 'export async function createBespokeApp({',
          replace: "import { useTable as __useTable } from './table.js';\nglobalThis.__bespokeTable = __useTable;\nexport async function createBespokeApp({",
        },
      ],
      run: leak('the headless table and TanStack are in no bundle of emptyApp'),
      expect: /expected \[ 'table' \] to deeply equal \[\]/,
    },
    {
      id: 'G6b',
      title: 'useTable in the adapter’s main entry (everything would carry it)',
      patch: [{ file: 'packages/react/dist/index.js', find: "export { WhenVisible } from './when-visible.js';", replace: "export { WhenVisible } from './when-visible.js';\nexport { useTable } from './table.js';" }],
      run: leak('the headless table and TanStack are in no bundle of everything'),
      expect: /expected \[ 'table' \] to deeply equal \[\]/,
    },
    {
      id: 'G7',
      title: 'TanStack without the bridge’s import: useTable itself imports it',
      patch: [
        {
          file: 'packages/react/dist/table.js',
          find: "import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';",
          replace:
            "import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';\nimport { tableFeatures as __tableFeatures } from '@tanstack/react-table';\nglobalThis.__tanstack = __tableFeatures;",
        },
      ],
      run: leak('the table scenario carries the headless table, but no TanStack'),
      expect: /TanStack without the bridge’s import/,
    },
    {
      id: 'G8',
      title: '@bespokecore/table a hard dependency of the React adapter (discovery would add it to every React app)',
      patch: [{ file: 'packages/react/package.json', find: '  "dependencies": {\n    "@bespokecore/http": "workspace:*"\n  },', replace: '  "dependencies": {\n    "@bespokecore/http": "workspace:*",\n    "@bespokecore/table": "workspace:*"\n  },' }],
      run: { vitest: 'packages/react/src/browser-safe.test.ts', name: 'optional peers, so discovery does not add the table package' },
      expect: /to not have property "@bespokecore\/table"/,
    },
    {
      id: 'G9',
      title: 'discovery lists every exported subpath, injectable or not: an app without the table imports @bespokecore/react/table at boot (pack:smoke: ERR_MODULE_NOT_FOUND)',
      patch: [
        {
          file: 'packages/core/src/discovery/discover.ts',
          find: '      const module = () => moduleIndex(pathToFileURL(jsEntry).href);',
          replace: '      const eager = moduleIndex(pathToFileURL(jsEntry).href);\n      const module = () => eager;',
        },
      ],
      run: { vitest: 'packages/core/src/discovery/discovery.test.ts', name: 'lists only the modules whose classes it injects' },
      expect: /a subpath without a class to inject is listed/,
    },
  ],
});
