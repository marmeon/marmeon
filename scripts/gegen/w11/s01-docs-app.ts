import { defineGegenproben } from '../define.ts';

/**
 * W11.1 — the docs app in sections: `apps/docs/docs.config.ts` lists ten sections of pages (`/docs/<slug>`, the file `docs/<slug>.md`
 * or a policy at the root), previous and next lead across the sections, a code block names its file (`title="…"`), a page still to be
 * written carries the pending marker. The measures, each with its own case:
 *
 * - **The boot check of the pages** — a `docs/*.md` without its entry (G1), a listed page without its file (G2), a slug listed twice
 *   (G3): the docs do not start, and the message names the cause.
 * - **One line of pages through every section** — `neighbours()` only within a section leaves the last page of a section without its
 *   next (G4).
 * - **The file name of a code block** — without the `title` taken from the info string the caption is gone (G5).
 * - **Links into the docs** — a page that still links to the old name `getting-started.md` (G6): the path is no page of the docs
 *   (no `docs/<slug>.md` of a section), so it is a link to a file — code text — and the check of the named files finds it missing
 *   ("names only files that exist"); the page-link check stays green, there is no `<a>` to follow. (Until W11 step 10 a README
 *   carried the link; the READMEs are no pages since.)
 * - **The pending marker** — rendered as text when it is not taken out (G7).
 * - **The root README is no page** — a link to it stays code text; the old rule made any `…README.md` a page link, `/README.md` (G8).
 */
const START = { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'highlights every code block of every page' };
const MARKDOWN = 'apps/docs/modules/docs/markdown.test.ts';
/** The whole describe: the link tests read what the page tests rendered before them (alone they see no page). */
const LINKS = { vitest: 'apps/docs/modules/docs/links.test.ts', name: 'every page' };

export default defineGegenproben({
  step: 'W11.1',
  cases: [
    // --- The boot check of the pages -------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'docs/routing.md without its entry in docs.config.ts: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "        { slug: 'routing', label: 'Routing' },\n", replace: '' }],
      run: START,
      expect: /docs\/routing\.md has no entry in docs\.config\.ts — add it to a section\./,
    },
    {
      id: 'G2',
      title: 'a listed page whose file does not exist: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "        { slug: 'routing', label: 'Routing' },\n", replace: "        { slug: 'routing', label: 'Routing' },\n        { slug: 'route-groups', label: 'Route Groups' },\n" }],
      run: START,
      expect: /docs\.config\.ts lists docs\/route-groups\.md, but it does not exist/,
    },
    {
      id: 'G3',
      title: 'a slug listed in two sections: the docs do not start',
      patch: [{ file: 'apps/docs/docs.config.ts', find: "        { slug: 'health', label: 'Health Checks' },\n", replace: "        { slug: 'health', label: 'Health Checks' },\n        { slug: 'routing', label: 'Routing' },\n" }],
      run: START,
      expect: /The page slug 'routing' is listed twice in docs\.config\.ts\./,
    },
    // --- One line of pages through every section --------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'previous and next only within a section: the last page of Getting Started has no next',
      patch: [
        {
          file: 'apps/docs/modules/docs/DocsRepository.ts',
          find: '    const list = this.pages();',
          replace: '    const list = this.pages().filter((other) => other.section === page.section);',
        },
      ],
      run: { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'leads from page to page across the sections' },
      expect: /expected 'starter-kit ← deployment → none' to be 'starter-kit ← deployment → lifecycle'/,
    },
    // --- The file name of a code block ------------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'the title of a code block not taken from its info string: no figure, no caption',
      patch: [{ file: 'apps/docs/modules/docs/markdown.ts', find: "title: (title?.[1] ?? title?.[2] ?? '').trim() };", replace: "title: '' };" }],
      run: { vitest: MARKDOWN, name: 'puts the file name of a code block with title' },
      expect: /expected '<pre>const x = 1;\\n<\/pre>' to be '<figure class="code"><figcaption>/,
    },
    // --- Links into the docs ------------------------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'a page links to getting-started.md, the old name of the installation page',
      patch: [{ file: 'docs/releases.md', find: '[deployment](deployment.md)', replace: '[deployment](getting-started.md)' }],
      run: LINKS,
      expect: /docs\/releases\.md: docs\/getting-started\.md/,
    },
    // --- The pending marker -------------------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'the pending marker seen but not taken out: the placeholder shows it as text',
      patch: [
        {
          file: 'apps/docs/modules/docs/markdown.ts',
          find: "    if (token.type === 'paragraph_open' && tokens[i + 1]!.content.trim() === PENDING_MARKER) {\n      pending = true;\n      i += 2; // the inline and the close token\n      continue;\n    }\n",
          replace: "    if (token.type === 'paragraph_open' && tokens[i + 1]!.content.trim() === PENDING_MARKER) pending = true;\n",
        },
      ],
      run: { vitest: MARKDOWN, name: 'renders no marker text' },
      expect: /&lt;!-- docs:pending --&gt;/,
    },
    // --- The root README is no page ---------------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'any path ending in README.md a page link again: a link to the root README becomes /README.md, a page that does not exist',
      patch: [{ file: 'apps/docs/modules/docs/markdown.ts', find: "  return path.endsWith('/README.md') ? `/${path}` : undefined;", replace: "  return path.endsWith('README.md') ? `/${path}` : undefined;" }],
      run: { vitest: MARKDOWN, name: 'keeps a link to the root README code text' },
      expect: /expected '<p>See <a href="\/README\.md#versions-a…' to contain '<span class="file">the README<\/span>'/,
    },
  ],
});
