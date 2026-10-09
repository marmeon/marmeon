import { defineGegenproben } from '../define.ts';

/**
 * W11.10 (second part) — the text an app developer reads speaks to them: no decision numbers, waves, personal dates or other
 * frameworks in what every new app copies or in the framework's messages; and the docs' own checks closed where they let a fault
 * through. The measures, each with its own cases:
 *
 * - **`check:source` rule 5 over what every new app copies** — a decision number in the starter's template (T1), a wave reference
 *   (T2), a personal date (T3) and another framework (T4) in the `make:auth` stubs; the template and the stubs taken out of the
 *   decision rule's files (T1b) or the personal date's guard against `Max-Age` (T3b), their unit tests are red.
 * - **`check:source` rule 6, the strings of a package's code** — a decision number in an error (T5), another framework in a text
 *   `make:*` writes (T6), a wave in a command's description (T6b); rule 6 without template and JSX text (T5b), its unit test is red.
 *   A decision number in a comment stays the maintainers' (T7, green).
 * - **The docs the framework names** — a solution's anchor GitHub cannot make (T8); the earlier pattern let it through (T8b, green).
 * - **A page names only files** — a docs page that links a package's directory (T9).
 * - **The boot check of the pages** — the root README listed as a page (T10); the check taken out, its unit test is red (T10b).
 */
const SOURCE = { command: ['node', 'scripts/check-source.ts'] } as const;
const ci = (name: string) => ({ vitest: 'scripts/ci.test.ts', name }) as const;
const NAMED = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every docs path the framework names' };
/** The whole describe: the file check runs beside the page tests. */
const LINKS = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every page' };
const START = { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'highlights every code block of every page' };
const DOCS_PATH = "const DOCS_PATH = /\\b(docs\\/[a-z0-9-]+\\.md)(?:#([^\\s`'\"()[\\]<>,;]*))?/g;";

export default defineGegenproben({
  step: 'W11.10b',
  cases: [
    // --- check:source rule 5 over what every new app copies ------------------------------------------------------------------------
    {
      id: 'T1',
      title: "a decision number in the starter's .env.example: check:source names it",
      patch: [
        {
          file: 'packages/create-marmeon/template/base/.env.example',
          find: '# Behind a load balancer that learns from /up/ready: seconds of requests after SIGTERM before the drain\n',
          replace: '# Behind a load balancer that learns from /up/ready: seconds of requests after SIGTERM before the drain (E163)\n',
        },
      ],
      run: SOURCE,
      expect: /a decision number in what every new app copies \([^)]*\): packages\/create-marmeon\/template\/base\/\.env\.example:15: # Behind a load balancer .* \(E163\)/,
    },
    {
      id: 'T2',
      title: 'a wave reference in a make:auth stub: check:source names it',
      patch: [
        {
          file: 'packages/auth/stubs/react/modules/auth/routes.ts',
          find: '  // A few sign-ups per minute and address — live validation of the form does not count.',
          replace: '  // A few sign-ups per minute and address (W9 step 11) — live validation of the form does not count.',
        },
      ],
      run: SOURCE,
      expect: /a wave reference in what every new app copies \([^)]*\): packages\/auth\/stubs\/react\/modules\/auth\/routes\.ts:37: \/\/ A few sign-ups per minute and address \(W9 step 11\)/,
    },
    {
      id: 'T3',
      title: 'a personal date in a make:auth migration: check:source names it',
      patch: [
        {
          file: 'packages/auth/stubs/react/modules/auth/migrations/0001_01_01_000005_add_first_verified_at_to_users_table.ts',
          find: ' * When the account confirmed an address for the first time — set once,',
          replace: ' * When the account confirmed an address for the first time (Max 07.10.) — set once,',
        },
      ],
      run: SOURCE,
      expect: /a personal date in what every new app copies \([^)]*\): packages\/auth\/stubs\/react\/modules\/auth\/migrations\/0001_01_01_000005_add_first_verified_at_to_users_table\.ts:4: \* When the account confirmed an address for the first time \(Max 07\.10\.\)/,
    },
    {
      id: 'T4',
      title: 'another framework in a make:auth controller: check:source names it',
      patch: [
        {
          file: 'packages/auth/stubs/react/modules/auth/controllers/LoginController.ts',
          find: '/** Five failed attempts per minute for one e-mail from one address. */',
          replace: "/** Five failed attempts per minute for one e-mail from one address (Laravel Breeze's default). */",
        },
      ],
      run: SOURCE,
      expect: /a comparison with another framework in what every new app copies \([^)]*\): packages\/auth\/stubs\/react\/modules\/auth\/controllers\/LoginController\.ts:20: .*Laravel Breeze's default/,
    },
    {
      id: 'T1b',
      title: 'the decision rule without the template and the stubs: its unit test is red',
      patch: [{ file: 'scripts/check-source.ts', find: '    pattern: /\\bE\\d{2,3}\\b/,\n    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES],', replace: '    pattern: /\\bE\\d{2,3}\\b/,\n    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS],' }],
      run: ci('reads what every new app copies too'),
      // Nothing found where the template's and the stubs' four decision numbers are expected.
      expect: /expected \[\] to deeply equal \[ …\(4\) \]/,
    },
    {
      id: 'T3b',
      title: "the personal date without its guard against a cookie's Max-Age: its unit test is red",
      patch: [{ file: 'scripts/check-source.ts', find: '    pattern: /\\bMax\\b(?![-\\w])|', replace: '    pattern: /\\bMax\\b|' }],
      run: ci('finds a personal date of the plan in what a new app copies'),
      // Four found where three are expected: `Max-Age=0` counts as a name.
      expect: /expected \[ …\(4\) \] to deeply equal \[ …\(3\) \]/,
    },
    // --- check:source rule 6: the strings of a package's code -----------------------------------------------------------------------
    {
      id: 'T5',
      title: "a decision number in an error of @marmeon/core: check:source names it",
      patch: [{ file: 'packages/core/src/application.ts', find: "throw new Error('An app in the build phase is never booted: ", replace: "throw new Error('An app in the build phase is never booted (E187): " }],
      run: SOURCE,
      expect: /the framework's messages speak to app developers \([^)]*\): packages\/core\/src\/application\.ts:127: a decision number: 'An app in the build phase is never booted \(E187\):/,
    },
    {
      id: 'T6',
      title: 'another framework in the text make:request writes into an app: check:source names it',
      patch: [
        {
          file: 'packages/cli/src/commands/make.ts',
          find: "  // The rules of @marmeon/validation, typed — messages in the request's language.",
          replace: "  // Laravel's rules, typed (@marmeon/validation) — messages in the request's language.",
        },
      ],
      run: SOURCE,
      expect: /the framework's messages speak to app developers \([^)]*\): packages\/cli\/src\/commands\/make\.ts:315: a comparison with another framework: \/\/ Laravel's rules, typed/,
    },
    {
      id: 'T6b',
      title: "a wave in a command's description: check:source names it",
      patch: [{ file: 'packages/session/src/commands/make-session-table.ts', find: "--upgrade for a table made before Marmeon 0.1.0'", replace: "--upgrade for a table made before W8'" }],
      run: SOURCE,
      expect: /the framework's messages speak to app developers \([^)]*\): packages\/session\/src\/commands\/make-session-table\.ts:16: a wave reference: 'Create the migration .* made before W8'/,
    },
    {
      id: 'T5b',
      title: 'rule 6 without the text of templates and JSX: its unit test is red',
      patch: [
        {
          file: 'scripts/check-source.ts',
          find: "      const isText = (type === 'Literal' && typeof value === 'string') || type === 'TemplateElement' || type === 'JSXText';",
          replace: "      const isText = type === 'Literal' && typeof value === 'string';",
        },
      ],
      run: ci('finds a decision number, a wave reference or another framework in a string'),
      // Three found where five are expected: the template's wave and the JSX text's decision number are missed.
      expect: /expected \[ …\(3\) \] to deeply equal \[ …\(5\) \]/,
    },
    {
      id: 'T7',
      title: "a decision number in a comment of a package's code is the maintainers': check:source stays green",
      patch: [
        {
          file: 'packages/core/src/application.ts',
          find: "    if (this.phase === 'build') throw new Error(",
          replace: "    // The build phase (E187, W10 step 9): never booted.\n    if (this.phase === 'build') throw new Error(",
        },
      ],
      run: SOURCE,
      expectGreen: true,
    },
    // --- The docs the framework names -----------------------------------------------------------------------------------------------
    {
      id: 'T8',
      title: "a solution's docs names an anchor GitHub cannot make: the check names it whole",
      patch: [{ file: 'packages/database/src/solutions.ts', find: "docs: 'docs/migrations.md#running-migrations',", replace: "docs: 'docs/migrations.md#Running-Migrations'," }],
      run: NAMED,
      expect: /packages\/database\/src\/solutions\.ts:37: docs\/migrations\.md#Running-Migrations — no anchor GitHub makes/,
    },
    {
      id: 'T8b',
      title: 'with the earlier pattern, which captured only a lower-case anchor, the same anchor passed as a page alone (whole pages allowed, as before 10c)',
      patch: [
        { file: 'packages/database/src/solutions.ts', find: "docs: 'docs/migrations.md#running-migrations',", replace: "docs: 'docs/migrations.md#Running-Migrations'," },
        { file: 'apps/docs/modules/docs/links.test.ts', find: DOCS_PATH, replace: 'const DOCS_PATH = /\\b(docs\\/[a-z0-9-]+\\.md)(?:#([a-z0-9_-]+))?/g;' },
        // Since 10c a reference to a whole page is refused too ("name the section too"): left in, the probe would be red for that reason, not
        // for the pattern. Taken out, only the pattern decides — as when the probe was written.
        { file: 'apps/docs/modules/docs/links.test.ts', find: 'else if (anchor === undefined && !CARD.test(path))', replace: 'else if (false)' },
      ],
      run: NAMED,
      expectGreen: true,
    },
    // --- A page names only files ----------------------------------------------------------------------------------------------------
    {
      id: 'T9',
      title: "a docs page that links a package's directory: the file check names it",
      patch: [{ file: 'docs/queues.md', find: '# Queues\n', replace: '# Queues\n\nSee [the queue package](../packages/queue/).\n' }],
      run: LINKS,
      expect: /docs\/queues\.md: packages\/queue — a directory, not a file/,
    },
    // --- The boot check of the pages ------------------------------------------------------------------------------------------------
    {
      id: 'T10',
      title: 'the root README listed as a page: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "        { slug: 'packages', label: 'Packages' },\n", replace: "        { slug: 'packages', label: 'Packages' },\n        { slug: 'readme', label: 'Readme', file: 'README.md' },\n" }],
      run: START,
      expect: /The page 'readme' names README\.md — the root README is no page of the docs/,
    },
    {
      id: 'T10b',
      title: 'the check for the root README taken out: its unit test is red',
      patch: [{ file: 'apps/docs/modules/docs/DocsRepository.ts', find: "    if (file === 'README.md') {", replace: '    if (file === `${file}?`) {' }],
      run: { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'a file of the wrong place and the root README' },
      // Five problems where six are expected: the README entry passes (Vitest shortens the lists).
      expect: /expected \[ …\(5\) \] to deeply equal \[ …\(6\) \]/,
    },
  ],
});
