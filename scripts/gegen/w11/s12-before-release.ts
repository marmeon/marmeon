import { defineGegenproben } from '../define.ts';

/**
 * W11.12 — no upgrade notes before the first release (E216, Max's reading of the docs): `UPGRADING.md` is one paragraph until there
 * was a release, and the checks that kept its 133 entries now ask for entries only from the first release on. The measures, each
 * with its own cases:
 *
 * - **`check-changesets` before the first release** — an entry that stands under no release is refused (R1); the rule taken out,
 *   its unit test is red (R1b).
 * - **The first release section switches the requirement on** — a `## Upgrading to …` section whose entries `UPGRADING_ANCHORS`
 *   does not list is refused (R2); the switch taken out, its unit test is red (R2b). That a listed entry must stand under its release
 *   is W10.9's G3.
 * - **No rename hint** (`check:source` rule 1 allows the company name only: nothing was released under the old name) — the hint
 *   back in the README is named (R3); the hint's allowance back for the README, the unit test is red (R3b).
 * - **No way back to the old token prefix** (`check:source` rule 4) — the way back in the upgrade guide is named (R4); the guide
 *   back in the prefix's allowance, the unit test is red (R4b).
 * - **The record of changes comes last in the search** — the guide's flag ignored by the sort, the search test is red: "likely"
 *   scores the same in the guide and in the release policy, and the guide is the navigation's first page (S1).
 */
const OLD_NAME = ['Bes', 'poke'].join('');
const OLD_PREFIX = `${['b', 'c'].join('')}_`;
const SOURCE = { command: ['node', 'scripts/check-source.ts'] } as const;
const CHANGESETS = { command: ['node', 'scripts/check-changesets.ts'] } as const;
const ci = (name: string) => ({ vitest: 'scripts/ci.test.ts', name }) as const;
const changesets = (name: string) => ({ vitest: 'scripts/check-changesets.test.ts', name }) as const;
const CHECK = 'scripts/check-changesets.ts';
/** The README's status line: the rename hint stood after it. */
const STATUS = 'Status: 0.1.0 — prepared, not published yet. MIT licence (`LICENSE`, copyright BespokeCode). Node 26.10 or newer, pnpm 12.\n';
/** The guide's first line: what the cases add follows the title. */
const TITLE = '# Upgrading\n\nMarmeon has had no release yet';

export default defineGegenproben({
  step: 'W11.12',
  cases: [
    // --- check-changesets before the first release ---------------------------------------------------------------------------------
    {
      id: 'R1',
      title: 'an entry in the upgrade guide before the first release: the release check says it stands under no release',
      patch: [
        {
          file: 'UPGRADING.md',
          find: TITLE,
          replace: '# Upgrading\n\n#### Low: the queue takes every queue\n\n*Likelihood of impact: low.* Nothing to do.\n\nMarmeon has had no release yet',
        },
      ],
      run: CHANGESETS,
      expect: /UPGRADING\.md: #low-the-queue-takes-every-queue stands under no release/,
    },
    {
      id: 'R1b',
      title: 'the release check without the rule: an entry under no release passes, its unit test is red',
      patch: [
        {
          file: CHECK,
          find: '    if (release === undefined) {\n      problems.push(`UPGRADING.md: #${current} stands under no release',
          replace: '    if (release === null) {\n      problems.push(`UPGRADING.md: #${current} stands under no release',
        },
      ],
      run: changesets('names an entry that stands under no release'),
      expect: /found: nothing — wanted: UPGRADING\.md: #low-a-change-before-any-release stands under no release/,
    },
    // --- The first release section switches the requirement on --------------------------------------------------------------------
    {
      id: 'R2',
      title: 'the first release section, its entries not listed: the release check names it',
      patch: [
        {
          file: 'UPGRADING.md',
          find: 'says what a version promises.\n',
          replace: 'says what a version promises.\n\n## Upgrading to 0.2.0 from 0.1.0\n\n#### Low: the queue takes every queue\n\n*Likelihood of impact: low.* Nothing to do.\n',
        },
      ],
      run: CHANGESETS,
      expect: /UPGRADING\.md has the section of 0\.2\.0, and scripts\/check-changesets\.ts lists none of its entries/,
    },
    {
      id: 'R2b',
      title: 'the release check without the switch: a release section nobody lists passes, its unit test is red',
      patch: [{ file: CHECK, find: '    if (!(version in anchors)) {\n', replace: '    if (version === undefined) {\n' }],
      run: changesets('switches on with the first release section'),
      expect: /found: nothing — wanted: UPGRADING\.md has the section of 0\.3\.0, and scripts\/check-changesets\.ts lists none of its entries/,
    },
    // --- No rename hint ------------------------------------------------------------------------------------------------------------
    {
      id: 'R3',
      title: 'the rename hint back in the README: check:source names it',
      patch: [{ file: 'README.md', find: STATUS, replace: `${STATUS}Marmeon was called ${OLD_NAME}Core up to 0.1.0.\n` }],
      run: SOURCE,
      expect: new RegExp(`README\\.md:31: Marmeon was called ${OLD_NAME}Core up to 0\\.1\\.0\\.`),
    },
    {
      id: 'R3b',
      title: 'the rename hint\'s allowance back for the README: its unit test is red',
      patch: [
        {
          file: 'scripts/check-source.ts',
          find: "  { pattern: new RegExp(`\\\\b${OLD_NAME}Code\\\\b`, 'g') },\n",
          replace: "  { pattern: new RegExp(`\\\\b${OLD_NAME}Code\\\\b`, 'g') },\n  { pattern: new RegExp(`Marmeon was called ${OLD_NAME}Core up to 0\\\\.1\\\\.0`, 'g'), files: ['README.md'] },\n",
        },
      ],
      run: ci('allows the old name only as the company name'),
      expect: /found: UPGRADING\.md:1: \*\*Marmeon was called .* \| docs\/versioning\.md:1: Marmeon was called/,
    },
    // --- No way back to the old token prefix ---------------------------------------------------------------------------------------
    {
      id: 'R4',
      title: 'the way back to the old token prefix in the upgrade guide: check:source names it',
      patch: [{ file: 'UPGRADING.md', find: TITLE, replace: `# Upgrading\n\nThe way back: \`AUTH_TOKEN_PREFIX=${OLD_PREFIX}\`.\n\nMarmeon has had no release yet` }],
      run: SOURCE,
      expect: new RegExp(`UPGRADING\\.md:3: The way back: \`AUTH_TOKEN_PREFIX=${OLD_PREFIX}\``),
    },
    {
      id: 'R4b',
      title: 'the upgrade guide back in the old prefix\'s allowance: its unit test is red',
      patch: [
        {
          file: 'scripts/check-source.ts',
          find: 'const OLD_PREFIX_ALLOWED: readonly Allowance[] = [];',
          replace: "const OLD_PREFIX_ALLOWED: readonly Allowance[] = [{ pattern: new RegExp(`AUTH_TOKEN_PREFIX=${OLD_TOKEN_PREFIX}`, 'g'), files: ['UPGRADING.md'] }];",
        },
      ],
      run: ci('allows it nowhere'),
      expect: /expected \[ Array\(1\) \] to deeply equal \[ …\(2\) \]/,
    },
    // --- The record of changes comes last in the search ----------------------------------------------------------------------------
    {
      id: 'S1',
      title: 'the search sorts the upgrade guide by its score alone: it comes before the release policy',
      patch: [
        {
          file: 'apps/docs/modules/docs/search.ts',
          find: 'hits.sort((a, b) => Number(a.entry.late ?? false) - Number(b.entry.late ?? false) || b.score - a.score',
          replace: 'hits.sort((a, b) => b.score - a.score',
        },
      ],
      run: { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'the record of changes comes after every other hit' },
      expect: /expected 0 to be greater than 1/,
    },
  ],
});
