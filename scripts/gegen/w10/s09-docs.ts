import { defineGegenproben } from '../define.ts';

/**
 * W10.9a — the docs and guides of Wave 10 (E168 pattern): a new guide `docs/validation.md` listed in `apps/docs/docs.config.ts`,
 * the Wave 10 parts of `deployment.md`, `security.md`, `getting-started.md`, CONTRIBUTING and an ordered UPGRADING.md whose overview
 * links every entry. Two measures of the docs app, each with its own cases, and the release rule that keeps the entries:
 *
 * - **The guides list** — a `docs/*.md` without its entry stops the docs app's start (G1: the new validation guide unlisted).
 * - **The link check** (`links.test.ts`) — a broken anchor anywhere is red: from the new guide into another page (G2), inside a guide
 *   (G2b: the deployment guide's link to one of its own sections). The link test reads what the page tests rendered before it — the
 *   run filters on its describe ('every page'), never on the test alone (W9).
 * - **The entries' anchors** (`UPGRADING_ANCHORS` of `check-changesets`) — a reworded entry loses its anchor (G3).
 *
 * W11 step 12 (E216): UPGRADING.md holds no entry until the first release. G2c (a link in its Wave 10 overview) is retired — the
 * overview is gone; G2b links the section on several machines, since the queue-index section went with the "older app"; G3 takes
 * the missing-entry check out of `check-changesets` and runs its unit test, which builds a guide with releases of its own.
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
      title: 'the deployment guide links to one of its own sections under another anchor (a reworded heading)',
      patch: [{ file: 'docs/deployment.md', find: '[more than one instance](#more-than-one-instance)', replace: '[more than one instance](#several-instances)' }],
      run: LINKS,
      expect: /\/docs\/deployment: #several-instances — no #several-instances on \/docs\/deployment/,
    },
    // G2c retired (W11 step 12, E216): UPGRADING.md has no Wave 10 overview — it holds no entry before the first release.
    // --- The entries' anchors -----------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'the release check without its missing-entry rule: a reworded entry of a release loses its anchor, and nobody notices',
      patch: [
        {
          file: 'scripts/check-changesets.ts',
          find: "      if (!entry) problems.push(`UPGRADING.md lacks an entry of ${version}: #${anchor}`);\n",
          replace: '      if (!entry) void anchor;\n',
        },
      ],
      run: { vitest: 'scripts/check-changesets.test.ts', name: 'names an entry that is missing, by its release' },
      expect: /found: nothing — wanted: UPGRADING\.md lacks an entry of 0\.3\.0: #low-a-change-of-030/,
    },
  ],
});
