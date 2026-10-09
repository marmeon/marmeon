import { defineGegenproben } from '../define.ts';

/**
 * W10.9a — the docs and guides of Wave 10 (E168 pattern): a new guide `docs/validation.md` listed in `apps/docs/docs.config.ts`,
 * the Wave 10 parts of `deployment.md`, `security.md`, `getting-started.md`, CONTRIBUTING and an ordered UPGRADING.md whose overview
 * links every entry. Two measures of the docs app, each with its own cases, and the release rule that keeps the entries:
 *
 * - **The guides list** — a `docs/*.md` without its entry stops the docs app's start (G1: the new validation guide unlisted).
 * - **The link check** (`links.test.ts`) — a broken anchor anywhere is red: from the new guide into another page (G2), inside a guide
 *   (G2b: the deployment guide's link to its own queue-index section), in UPGRADING.md's new Wave 10 overview (G2c). The link test
 *   reads what the page tests rendered before it — the run filters on its describe ('every page'), never on the test alone (W9).
 * - **The entries' anchors** (`UPGRADING_ANCHORS` of `check-changesets`) — a reworded Wave 10 heading loses its anchor (G3).
 *
 * Since the docs have sections, the guides are pages of them (`/docs/<slug>`): the anchors and reasons moved with them, the measures are
 * the same. The validation page links no README any more and the READMEs are no pages (W11 step 10): G2 patches its link into the
 * configuration page.
 */
const START = { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'highlights every code block of every page' };
/** The whole describe: the link test reads what the page tests rendered before it (alone it sees no page). */
const LINKS = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every page' };

export default defineGegenproben({
  step: 'W10.9',
  cases: [
    // --- The guides list --------------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the new validation guide without its entry in docs.config.ts: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "        { slug: 'validation', label: 'Validation' },\n", replace: '' }],
      run: START,
      expect: /docs\/validation\.md has no entry in docs\.config\.ts — add it to a section/,
    },
    // --- The link check -----------------------------------------------------------------------------------------------------------
    {
      id: 'G2',
      title: 'the validation guide links to an anchor the configuration page does not have',
      patch: [{ file: 'docs/validation.md', find: '(configuration.md#reading-variables)', replace: '(configuration.md#reading-the-variables)' }],
      run: LINKS,
      expect: /\/docs\/validation: \/docs\/configuration#reading-the-variables — no #reading-the-variables on \/docs\/configuration/,
    },
    {
      id: 'G2b',
      title: 'the deployment guide links to its own queue-index section under another anchor (a reworded heading)',
      patch: [{ file: 'docs/deployment.md', find: '([the migration](#the-queue-index-of-an-older-app))', replace: '([the migration](#the-queue-index))' }],
      run: LINKS,
      expect: /\/docs\/deployment: #the-queue-index — no #the-queue-index on \/docs\/deployment/,
    },
    {
      id: 'G2c',
      title: 'UPGRADING.md’s overview of Wave 10 links to an entry under another anchor',
      patch: [{ file: 'UPGRADING.md', find: '[`uploads:prune --force`](#low-uploadsprune---hours-below-uploads_lifetime-needs---force)', replace: '[`uploads:prune --force`](#low-uploadsprune-needs-force)' }],
      run: LINKS,
      expect: /\/docs\/upgrading: #low-uploadsprune-needs-force — no #low-uploadsprune-needs-force on \/docs\/upgrading/,
    },
    // --- The entries' anchors -----------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'a Wave 10 entry reworded while ordering UPGRADING.md: its anchor is gone, the release check names it',
      patch: [{ file: 'UPGRADING.md', find: '#### Low: `uploads:prune --hours` below `UPLOADS_LIFETIME` needs `--force`\n', replace: '#### Low: `uploads:prune --hours` below the lifetime needs `--force`\n' }],
      run: { command: ['node', 'scripts/check-changesets.ts'] },
      expect: /UPGRADING\.md lacks a Wave 10 entry: #low-uploadsprune---hours-below-uploads_lifetime-needs---force/,
    },
  ],
});
