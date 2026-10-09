import { defineGegenproben } from '../define.ts';

/**
 * W9.10a — the docs and guides of Wave 9 (E168 pattern): four new guides (`docs/lists.md`, `tables.md`, `navigation.md`,
 * `realtime.md`) listed in `apps/docs/docs.config.ts`, and every link between them, the READMEs and UPGRADING.md leading to a page and
 * an anchor that exist. Two measures, each with its own cases:
 *
 * - **The guides list** — a `docs/*.md` without its entry stops the docs app's start (G1: a new guide unlisted; G2: the check that
 *   finds it taken out, its own test turns red).
 * - **The link check** (`links.test.ts`) — a broken anchor anywhere is red: from UPGRADING.md into a page (G3), into another guide
 *   (G3b), inside UPGRADING.md's new overview of the wave (G3c).
 *
 * Since the docs have sections, the guides are pages of them (`/docs/<slug>`; `lists.md` is `pagination.md`): the anchors and reasons
 * moved with them, the measures are the same. The rewritten tables page links no README and no pending page by anchor (W11 step 7):
 * G3 patches a README link of UPGRADING.md, G3b the tables page's link into the requests page. The READMEs are no pages since W11
 * step 10 (cards for npm): G3 patches UPGRADING.md's link into the session page that replaced the README's section.
 */
const START = { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'highlights every code block of every page' };
const UNLISTED = { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'stops the start for a docs/*.md without its entry in a section' };
/** The whole describe: the link test reads what the page tests rendered before it (alone it sees no page). */
const LINKS = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every page' };

export default defineGegenproben({
  step: 'W9.10',
  cases: [
    // --- The guides list --------------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'a new guide without its entry in docs.config.ts: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "        { slug: 'tables', label: 'Data Tables' },\n", replace: '' }],
      run: START,
      expect: /docs\/tables\.md has no entry in docs\.config\.ts — add it to a section/,
    },
    {
      id: 'G2',
      title: 'the check for unlisted docs/*.md taken out: an unlisted guide would be served nowhere, and nobody notices',
      patch: [
        {
          file: 'apps/docs/modules/docs/DocsRepository.ts',
          find: "      if (!files.has(`docs/${name}`)) problems.push(`docs/${name} has no entry in docs.config.ts — add it to a section.`);",
          replace: '      void name;',
        },
      ],
      run: UNLISTED,
      // Vitest shortens the lists: two problems found (the missing SECURITY.md and docs/routing.md) where three are expected (and
      // docs/brandnew.md unlisted).
      expect: /expected \[ …\(2\) \] to deeply equal \[ …\(3\) \]/,
    },
    // --- The link check -----------------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'UPGRADING.md links to an anchor the session page does not have',
      patch: [{ file: 'UPGRADING.md', find: '(docs/session.md#requests-that-must-not-overlap)', replace: '(docs/session.md#blocking-routes)' }],
      run: LINKS,
      expect: /\/docs\/upgrading: \/docs\/session#blocking-routes — no #blocking-routes on \/docs\/session/,
    },
    {
      id: 'G3b',
      title: 'a page links to an anchor another page does not have',
      patch: [{ file: 'docs/tables.md', find: '(requests.md#how-a-query-is-parsed)', replace: '(requests.md#how-a-query)' }],
      run: LINKS,
      expect: /\/docs\/tables: \/docs\/requests#how-a-query — no #how-a-query on \/docs\/requests/,
    },
    {
      id: 'G3c',
      title: 'UPGRADING.md’s overview of Wave 9 links to an entry under another anchor (a reworded heading)',
      patch: [{ file: 'UPGRADING.md', find: '[pnpm 12.9.1](#low-pnpm-1291)', replace: '[pnpm 12.9.1](#low-pnpm-12-9-1)' }],
      run: LINKS,
      expect: /\/docs\/upgrading: #low-pnpm-12-9-1 — no #low-pnpm-12-9-1 on \/docs\/upgrading/,
    },
  ],
});
