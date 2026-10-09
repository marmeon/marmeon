import { defineGegenproben } from '../define.ts';

/**
 * W11.10 (first part) — the package READMEs are cards for npm, not pages: the framework's code names pages of the docs, `check:source`
 * keeps the maintainers' record out of the docs, and the docs app serves only `docs/*.md` and the policies. The measures, each with
 * its own cases:
 *
 * - **`check:source` rule 5** (`DOC_TEXT_RULES`) over the real repository — a decision number in a docs page (G1), a wave reference
 *   in a package README (G2), the pending marker as a line of a page (G3); and each part's pattern or files taken out, its unit test
 *   in `scripts/ci.test.ts` turns red (G1b, G2b, G3b).
 * - **The docs the framework names** (`links.test.ts`, "every docs path the framework names leads to a page and its anchor") — a
 *   solution whose `docs` names an anchor its page does not have (G4), or a package README (G5).
 * - **No package pages** — a docs page that links to a package README: the link stays a page link no page answers, the link test
 *   reports it (G6); the README mapping taken out, the link would turn into code text that hides it — its unit test is red (G6b).
 * - **The boot check of the pages** without the package checks around it — a page's file gone while its entry stays (G7: a policy
 *   entry naming a file that is not there); the check taken out, the start fails without naming the file (G7b).
 */
const SOURCE = { command: ['node', 'scripts/check-source.ts'] } as const;
const ci = (name: string) => ({ vitest: 'scripts/ci.test.ts', name }) as const;
/** The whole file's app is made in its beforeAll; the test reads the repository through it. */
const NAMED = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every docs path the framework names' };
/** The whole describe: the link test reads what the page tests rendered before it (alone it sees no page). */
const LINKS = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every page' };
const START = { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'highlights every code block of every page' };

export default defineGegenproben({
  step: 'W11.10',
  cases: [
    // --- check:source rule 5 over the repository ------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'a decision number in docs/queues.md: check:source names it',
      patch: [{ file: 'docs/queues.md', find: 'Some work does not belong in a request: a mail to send', replace: 'Some work does not belong in a request (E123): a mail to send' }],
      run: SOURCE,
      expect: /a decision number in the docs \([^)]*\): docs\/queues\.md:5: Some work does not belong in a request \(E123\)/,
    },
    {
      id: 'G2',
      title: 'a wave reference in a package README: check:source names it',
      patch: [{ file: 'packages/live/README.md', find: 'Live updates for Marmeon apps: a page follows a channel', replace: 'Live updates for Marmeon apps since Wave 9: a page follows a channel' }],
      run: SOURCE,
      expect: /a wave reference in the docs \([^)]*\): packages\/live\/README\.md:3: Live updates for Marmeon apps since Wave 9/,
    },
    {
      id: 'G3',
      title: 'the pending marker as a line of docs/routing.md: check:source names it',
      patch: [{ file: 'docs/routing.md', find: '# Routing\n', replace: '# Routing\n<!-- docs:pending -->\n' }],
      run: SOURCE,
      expect: /the pending marker in the docs \([^)]*\): docs\/routing\.md:2: <!-- docs:pending -->/,
    },
    {
      id: 'G1b',
      title: 'the decision-number rule reads no file: its unit test is red',
      patch: [{ file: 'scripts/check-source.ts', find: '    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS],', replace: '    files: [],' }],
      run: ci('finds a decision number in the docs'),
      // Vitest shortens the lists: nothing found where five hits are expected.
      expect: /expected \[\] to deeply equal \[ …\(5\) \]/,
    },
    {
      id: 'G2b',
      title: 'the wave rule without "Wave 9": its unit test is red',
      patch: [{ file: 'scripts/check-source.ts', find: '    pattern: /\\b(?:W\\d+(?:\\.\\d+)?|[Ww]ave \\d+)\\b/,', replace: '    pattern: /\\bW\\d+(?:\\.\\d+)?\\b/,' }],
      run: ci('finds a wave reference in the docs and the package cards only'),
      // Two of the three found: "New in Wave 9." of the package README is missed.
      expect: /expected \[ …\(2\) \] to deeply equal \[ …\(3\) \]/,
    },
    {
      id: 'G3b',
      title: 'the marker rule only at the start of a line without spaces: its unit test is red',
      patch: [{ file: 'scripts/check-source.ts', find: '    pattern: /^\\s*<!-- docs:pending -->\\s*$/,', replace: '    pattern: /^<!-- docs:pending -->$/,' }],
      run: ci('finds the pending marker as a line of its own'),
      // One of the two found: the indented marker of docs/middleware.md is missed.
      expect: /expected \[ Array\(1\) \] to deeply equal \[ …\(2\) \]/,
    },
    // --- The docs the framework names -----------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: "a solution's docs names an anchor its page does not have",
      patch: [{ file: 'packages/database/src/solutions.ts', find: "docs: 'docs/migrations.md#running-migrations',", replace: "docs: 'docs/migrations.md#running-the-migrations'," }],
      run: NAMED,
      expect: /packages\/database\/src\/solutions\.ts:\d+: docs\/migrations\.md#running-the-migrations — no #running-the-migrations on that page/,
    },
    {
      id: 'G5',
      title: "a solution's docs names a package README",
      patch: [{ file: 'packages/devtools/src/provider.ts', find: "docs: 'docs/devtools.md#settings',", replace: "docs: 'packages/devtools/README.md#settings'," }],
      run: NAMED,
      expect: /packages\/devtools\/src\/provider\.ts:\d+: packages\/devtools\/README\.md names a README — the docs live in docs\//,
    },
    // --- No package pages -----------------------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'a docs page links to a package README: no page answers it',
      patch: [{ file: 'docs/queues.md', find: '[transactions](transactions.md)', replace: '[transactions](../packages/queue/README.md)' }],
      run: LINKS,
      expect: /\/docs\/queues: \/packages\/queue\/README\.md — no such page/,
    },
    {
      id: 'G6b',
      title: 'a link to a package README turned into code text: the link check would never see it',
      patch: [{ file: 'apps/docs/modules/docs/markdown.ts', find: "  return path.endsWith('/README.md') ? `/${path}` : undefined;", replace: '  return undefined;' }],
      run: { vitest: 'apps/docs/modules/docs/markdown.test.ts', name: 'keeps a link to a package README a page link' },
      expect: /expected '<p>See <span class="file">the router<…' to contain '<a href="\/packages\/router\/README\.md#m…'/,
    },
    // --- The boot check of the pages ------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'a page whose file is gone while its entry stays: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "file: 'SECURITY.md' },", replace: "file: 'SECURITY-POLICY.md' }," }],
      run: START,
      expect: /docs\.config\.ts lists SECURITY-POLICY\.md, but it does not exist/,
    },
    {
      id: 'G7b',
      title: 'the check for a listed file taken out: the start fails without naming the entry',
      patch: [
        {
          file: 'apps/docs/modules/docs/DocsRepository.ts',
          find: '    if (!existsSync(join(source, file))) problems.push(`docs.config.ts lists ${file}, but it does not exist in ${source}.`);',
          replace: '    void source;',
        },
      ],
      run: { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'the app does not boot then' },
      expect: /to throw error matching \/doc…\/routing\\\.md, but it does not exist but got 'ENOENT: no such file or directory/,
    },
  ],
});
