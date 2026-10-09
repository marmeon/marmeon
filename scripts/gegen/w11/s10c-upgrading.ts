import { defineGegenproben } from '../define.ts';

/**
 * W11.10 (third part) — the Upgrade Guide speaks to its readers (E215), and the final review's guards. The measures, each with its
 * own cases:
 *
 * - **`check:source` rule 5 over `UPGRADING.md`** — a decision number (U1), a wave heading (U2) and another framework (U3) in the
 *   guide; another framework in CONTRIBUTING, a page of the docs too (U3b). The guide taken back out of the decision rule's files
 *   (U4) or of the wave rule's (U5): their unit tests are red.
 * - **`check-changesets`, every entry under its section** — the wave heading of U2 also moves the devtools hints out of their
 *   section, which the release check names on its own (U2b, a pair with U2: each guard alone is red); a step heading inside 0.2.0
 *   moves its entries out of the release (U6); the section taken from `###` headings only again, the release's own `##` heading
 *   no longer counts and its unit test is red (U6b).
 * - **The anchor check of the docs app reads the cards** — a package card (C1) and the root README (C1b) linking an anchor its
 *   page does not have; the cards taken out of the scan, the count of named pages falls below its floor (C1c); a stub of another
 *   package than `auth` naming a wrong anchor (C2).
 * - **`check:source` rule 6 reads the launchers** — a decision number in a string of `marmeon`'s bin (C3).
 * - **Code names a section, not a page** (the acceptance's F2) — `make:docker`'s hint without its anchor (C4); a card's page link
 *   stays allowed (the cards list pages, C4b green).
 * - **The phone menu scrolls** (the acceptance's defect) — the overlay without `align-self: auto` takes the sticky sidebar's
 *   `start` and grows to its links: the stylesheet test is red (M1).
 */
const SOURCE = { command: ['node', 'scripts/check-source.ts'] } as const;
const CHANGESETS = { command: ['node', 'scripts/check-changesets.ts'] } as const;
const ci = (name: string) => ({ vitest: 'scripts/ci.test.ts', name }) as const;
const NAMED = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every docs path the framework names' };
const WANTED = "/^(?:packages\\/[^/]+\\/stubs|packages\\/create-marmeon\\/template|apps\\/web-app|apps\\/blank-app)\\//.test(path) ||\n        /^(?:packages\\/[^/]+\\/)?README\\.md$/.test(path);";

export default defineGegenproben({
  step: 'W11.10c',
  cases: [
    // --- check:source rule 5 over UPGRADING.md -------------------------------------------------------------------------------------
    {
      id: 'U1',
      title: 'a decision number back in an entry of the Upgrade Guide: check:source names it',
      patch: [{ file: 'UPGRADING.md', find: 'included. Now STARTTLS is required: such a send fails', replace: 'included. Now STARTTLS is required (E192): such a send fails' }],
      run: SOURCE,
      expect: /a decision number in the docs \([^)]*\): UPGRADING\.md:342: included\. Now STARTTLS is required \(E192\)/,
    },
    {
      id: 'U2',
      title: 'a step of 0.1.0 named by its wave again: check:source names the heading',
      patch: [{ file: 'UPGRADING.md', find: '\n### Devtools and observability\n', replace: '\n### Wave 7 — devtools and observability\n' }],
      run: SOURCE,
      expect: /a wave reference in the docs \([^)]*\): UPGRADING\.md:1318: ### Wave 7 — devtools and observability/,
    },
    {
      id: 'U3',
      title: 'the Upgrade Guide compares with another framework again: check:source names it',
      patch: [
        {
          file: 'UPGRADING.md',
          find: 'What changes for an app from one version of Marmeon to the next. Each entry',
          replace: "What changes for an app from one version of Marmeon to the next, in Laravel's manner. Each entry",
        },
      ],
      run: SOURCE,
      expect: /a comparison with another framework in the docs \([^)]*\): UPGRADING\.md:8: What changes .* in Laravel's manner/,
    },
    {
      id: 'U3b',
      title: 'CONTRIBUTING, a page of the docs, compares with another framework: check:source names it (C-M2)',
      patch: [{ file: 'CONTRIBUTING.md', find: 'Thank you for helping. This page covers', replace: 'Thank you for helping. Like Laravel’s guide, this page covers' }],
      run: SOURCE,
      expect: /a comparison with another framework in the docs \([^)]*\): CONTRIBUTING\.md:3: Thank you for helping\. Like Laravel/,
    },
    {
      id: 'U4',
      title: 'the Upgrade Guide exempt from the decision rule again: its unit test is red',
      patch: [{ file: 'scripts/check-source.ts', find: 'const ROOT_TEXTS = /^(?:README|CONTRIBUTING|SECURITY|UPGRADING)\\.md$/;', replace: 'const ROOT_TEXTS = /^(?:README|CONTRIBUTING|SECURITY)\\.md$/;' }],
      run: ci('finds a decision number in the docs'),
      // Vitest shortens the lists: five found where six are expected — UPGRADING.md's is missed.
      expect: /expected \[ …\(5\) \] to deeply equal \[ …\(6\) \]/,
    },
    {
      id: 'U5',
      title: 'the wave rule without the Upgrade Guide: its unit test is red',
      patch: [{ file: 'scripts/check-source.ts', find: '    files: [DOCS_PAGES, PACKAGE_CARDS, UPGRADE_GUIDE, APP_COPIES],', replace: '    files: [DOCS_PAGES, PACKAGE_CARDS, APP_COPIES],' }],
      run: ci('finds a wave reference in the docs, the package cards and the upgrade guide'),
      // Three of the four found: UPGRADING.md's "### Wave 10" is missed.
      expect: /expected \[ …\(3\) \] to deeply equal \[ …\(4\) \]/,
    },
    // --- check-changesets: every entry under its section ---------------------------------------------------------------------------
    {
      id: 'U2b',
      title: 'the same wave heading: the release check names the devtools hints that left their section',
      patch: [{ file: 'UPGRADING.md', find: '\n### Devtools and observability\n', replace: '\n### Wave 7 — devtools and observability\n' }],
      run: CHANGESETS,
      masks: 'U2',
      expect: /UPGRADING\.md: #low-contributors-pnpm-run-ci-is-the-check-command--not-pnpm-ci \(the devtools hint 1\) is under "Wave 7 — devtools and observability", not "Devtools and observability"/,
    },
    {
      id: 'U6',
      title: 'a step heading inside 0.2.0: the release check names the entries it took out of the release',
      patch: [
        {
          file: 'UPGRADING.md',
          find: '\n#### Medium: the navigator uses the Navigation API',
          replace: '\n### Client and navigation\n\n#### Medium: the navigator uses the Navigation API',
        },
      ],
      run: CHANGESETS,
      expect: /UPGRADING\.md: #medium-the-navigator-uses-the-navigation-api--historystate-is-null-its-navigate-events-are-visible \(an entry of "Upgrading to 0\.2\.0"\) is under "Client and navigation", not "Upgrading to 0\.2\.0"/,
    },
    {
      id: 'U6b',
      title: 'the section taken from ### headings only, as before: the release’s own heading no longer counts — its unit test is red',
      patch: [{ file: 'scripts/check-changesets.ts', find: "    if (heading && heading[1] !== '####') section = heading[2]!;", replace: "    if (heading?.[1] === '###') section = heading[2]!;" }],
      run: { vitest: 'scripts/check-changesets.test.ts', name: 'takes the release’s own heading as the section' },
      expect: /UPGRADING\.md: #low-a-change-of-020 \(an entry of "Upgrading to 0\.2\.0"\) is under "", not "Upgrading to 0\.2\.0"/,
    },
    // --- The anchor check of the docs app reads the cards, the root README and every stub --------------------------------------------
    {
      id: 'C1',
      title: 'a package card links an anchor its page does not have: the anchor check names it (C-I1)',
      patch: [
        {
          file: 'packages/queue/README.md',
          find: '(https://github.com/marmeon/marmeon/blob/main/docs/queues.md#running-workers)',
          replace: '(https://github.com/marmeon/marmeon/blob/main/docs/queues.md#running-the-workers)',
        },
      ],
      run: NAMED,
      expect: /packages\/queue\/README\.md:46: docs\/queues\.md#running-the-workers — no #running-the-workers on that page/,
    },
    {
      id: 'C1b',
      title: 'the root README links an anchor its page does not have: the anchor check names it',
      patch: [{ file: 'README.md', find: '(docs/installation.md#the-first-day-after-a-release)', replace: '(docs/installation.md#the-first-day)' }],
      run: NAMED,
      expect: /README\.md:59: docs\/installation\.md#the-first-day — no #the-first-day on that page/,
    },
    {
      id: 'C1c',
      title: 'the cards and the README out of the scan again: the count of named pages falls below its floor',
      patch: [{ file: 'apps/docs/modules/docs/links.test.ts', find: WANTED, replace: "/^(?:packages\\/auth\\/stubs|packages\\/create-marmeon\\/template|apps\\/web-app|apps\\/blank-app)\\//.test(path);" }],
      run: NAMED,
      expect: /expected 34 to be greater than 165/,
    },
    {
      id: 'C2',
      title: "a stub of the queue package names an anchor its page does not have: the anchor check reads every package's stubs (C-M5)",
      patch: [
        {
          file: 'packages/queue/stubs/migrations/create_jobs_table.ts',
          find: "// and a row per failed job, with the error (redacted) that ended it. `marmeon queue:prune-failed` empties the second.\n",
          replace: "// and a row per failed job, with the error (redacted) that ended it. `marmeon queue:prune-failed` empties the second.\n// See docs/queues.md#the-jobs-table.\n",
        },
      ],
      run: NAMED,
      expect: /packages\/queue\/stubs\/migrations\/create_jobs_table\.ts:6: docs\/queues\.md#the-jobs-table — no #the-jobs-table on that page/,
    },
    // --- check:source rule 6 reads the launchers ------------------------------------------------------------------------------------
    {
      id: 'C3',
      title: "a decision number in a string of marmeon's launcher: check:source names it (C-M3)",
      patch: [{ file: 'packages/cli/bin/marmeon.js', find: "const SOURCE_CONDITION = '@marmeon/source';", replace: "const SOURCE_CONDITION = '@marmeon/source';\nconst NOTE = 'one process (E159)';" }],
      run: SOURCE,
      expect: /the framework's messages speak to app developers \([^)]*\): packages\/cli\/bin\/marmeon\.js:30: a decision number: 'one process \(E159\)'/,
    },
    // --- Code names a section, not a page -------------------------------------------------------------------------------------------
    {
      id: 'C4',
      title: "make:docker's hint names the deployment page without its section: the anchor check names it",
      patch: [{ file: 'packages/cli/src/commands/make-docker.ts', find: 'blob/main/docs/deployment.md#the-docker-image', replace: 'blob/main/docs/deployment.md' }],
      run: NAMED,
      expect: /packages\/cli\/src\/commands\/make-docker\.ts:57: docs\/deployment\.md — name the section too/,
    },
    {
      id: 'C4b',
      title: 'a card links a whole page: allowed — the cards list the pages',
      patch: [{ file: 'packages/queue/README.md', find: '(https://github.com/marmeon/marmeon/blob/main/docs/queues.md#running-workers)', replace: '(https://github.com/marmeon/marmeon/blob/main/docs/queues.md)' }],
      run: NAMED,
      expectGreen: true,
    },
    // --- The phone menu scrolls -----------------------------------------------------------------------------------------------------
    {
      id: 'M1',
      title: "the phone menu without align-self: auto takes the sticky sidebar's start and grows to its links: the stylesheet test is red",
      patch: [
        {
          file: 'apps/docs/styles/docs.css',
          find: "    /* Between the header and the bottom, scrolling: `start` (the sticky sidebar's) would size it to its links. */\n    align-self: auto;\n",
          replace: '',
        },
      ],
      run: { vitest: 'apps/docs/modules/docs/styles.test.ts', name: 'opens the navigation as an overlay' },
      expect: /expected \[ 'auto', 'normal', 'stretch' \] to include 'start'/,
    },
  ],
});
