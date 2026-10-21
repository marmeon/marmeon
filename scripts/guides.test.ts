import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDE, guideProblems, knownCommands } from './guides.ts';
import { OVERLAY } from './notes-demo.ts';
import { tempDir } from './test/temp-dir.js';

describe('the first-app guide', () => {
  it('shows exactly the files, the edits and the commands of the notes demo', () => {
    expect(guideProblems(readFileSync(GUIDE, 'utf8'), { page: 'docs/first-app.md', overlay: OVERLAY })).toEqual([]);
  });
});

describe('knownCommands', () => {
  it('finds the commands of the packages', () => {
    const known = knownCommands();
    for (const name of ['make:module', 'make:controller', 'make:migration', 'migrate', 'db:types', 'route:types', 'start']) expect(known.has(name), name).toBe(true);
    expect(known.has('make:migraton')).toBe(false);
  });
});

describe('guideProblems', () => {
  const known = new Set(['make:module', 'migrate']);
  const page = 'docs/first-app.md';
  function overlay() {
    const dir = tempDir('marmeon-guide-');
    mkdirSync(join(dir, 'files/modules/notes'), { recursive: true });
    writeFileSync(join(dir, 'files/modules/notes/a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'edits.json'), JSON.stringify([{ file: 'layout.tsx', find: 'x', replace: 'x\ny' }]));
    writeFileSync(join(dir, 'commands.json'), JSON.stringify({ beforeCopy: ['marmeon make:module notes'], afterCopy: ['marmeon migrate'] }));
    return dir;
  }
  const good = [
    '```sh', 'pnpm marmeon make:module notes', '```',
    '```ts title="modules/notes/a.ts"', 'one', 'two', 'three', '```',
    '```tsx title="layout.tsx"', 'x', 'y', '```',
    '```sh', 'pnpm marmeon migrate', '```',
  ];

  it('accepts a guide that matches', () => {
    expect(guideProblems(good.join('\n'), { page, overlay: overlay(), known })).toEqual([]);
  });

  it('accepts an excerpt of a file when the file is shown in full elsewhere', () => {
    expect(guideProblems([...good, '```ts title="modules/notes/a.ts"', 'two', '```'].join('\n'), { page, overlay: overlay(), known })).toEqual([]);
  });

  it('names the guide line and the file of a block that differs from the demo', () => {
    const wrong = good.map((line) => (line === 'two' ? 'zwei' : line));
    const dir = overlay();
    expect(guideProblems(wrong.join('\n'), { page, overlay: dir, known })).toEqual([
      `docs/first-app.md:4 (modules/notes/a.ts): the block is not part of ${dir}/files/modules/notes/a.ts.`,
      `docs/first-app.md: ${dir}/files/modules/notes/a.ts is not shown in full.`,
    ]);
  });

  it('refuses a titled block of a file the demo does not have', () => {
    const problems = guideProblems([...good, '```ts title="modules/notes/b.ts"', 'x', '```'].join('\n'), { page, overlay: overlay(), known });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/first-app\.md:\d+ \(modules\/notes\/b\.ts\): the block is neither/);
  });

  it('names the line of a marmeon command that does not exist', () => {
    const typo = good.map((line) => (line === 'pnpm marmeon migrate' ? 'pnpm marmeon migrat' : line));
    expect(guideProblems(typo.join('\n'), { page, overlay: overlay(), known }).filter((problem) => problem.includes('not a command'))).toEqual([
      'docs/first-app.md:14: "marmeon migrat" is not a command of the framework.',
    ]);
  });

  it('names a missing edit and a missing or misplaced command', () => {
    const problems = guideProblems(['```sh', 'pnpm marmeon migrate', 'pnpm marmeon make:module notes', '```', '```ts title="modules/notes/a.ts"', 'one', 'two', 'three', '```'].join('\n'), {
      page,
      overlay: overlay(),
      known,
    });
    expect(problems).toEqual([
      'docs/first-app.md: the edit of layout.tsx that adds "y" is not shown.',
      'docs/first-app.md: the command "pnpm marmeon migrate" of commands.json is missing or out of order in the sh blocks.',
    ]);
  });

  describe('with a reference', () => {
    /** An overlay of commands only, as a recipe has it. */
    function bare() {
      const dir = tempDir('marmeon-guide-');
      writeFileSync(join(dir, 'edits.json'), '[]');
      writeFileSync(join(dir, 'commands.json'), JSON.stringify({ beforeCopy: ['marmeon make:module notes'], afterCopy: [] }));
      return dir;
    }
    const options = { page: 'docs/recipe-x.md', reference: 'apps/web-app', known };
    const file = 'modules/bookmarks/policies/BookmarkPolicy.ts';
    const first = readFileSync(new URL(`../apps/web-app/${file}`, import.meta.url), 'utf8').split('\n')[0]!;

    it('accepts a block that is part of the file of that path below the reference', () => {
      const markdown = ['```sh', 'pnpm marmeon make:module notes', '```', `\`\`\`ts title="${file}"`, first, '```'].join('\n');
      expect(guideProblems(markdown, { ...options, overlay: bare() })).toEqual([]);
    });

    it('names a block that differs from the reference file', () => {
      const markdown = ['```sh', 'pnpm marmeon make:module notes', '```', `\`\`\`ts title="${file}"`, `${first} // changed`, '```'].join('\n');
      expect(guideProblems(markdown, { ...options, overlay: bare() })).toEqual([`docs/recipe-x.md:4 (${file}): the block is not part of apps/web-app/${file}.`]);
    });

    it('refuses a titled block of a file neither the overlay nor the reference has', () => {
      const markdown = ['```sh', 'pnpm marmeon make:module notes', '```', '```ts title="modules/bookmarks/nope.ts"', 'x', '```'].join('\n');
      expect(guideProblems(markdown, { ...options, overlay: bare() })).toHaveLength(1);
    });

    it('does not read a title that leaves the reference', () => {
      const markdown = ['```sh', 'pnpm marmeon make:module notes', '```', '```ts title="../../package.json"', '{', '```'].join('\n');
      expect(guideProblems(markdown, { ...options, overlay: bare() })).toHaveLength(1);
    });
  });

  describe('requireTitles', () => {
    const sh = ['```sh', 'pnpm marmeon make:module notes', '```'];
    function bare() {
      const dir = tempDir('marmeon-guide-');
      writeFileSync(join(dir, 'edits.json'), '[]');
      writeFileSync(join(dir, 'commands.json'), JSON.stringify({ beforeCopy: ['marmeon make:module notes'], afterCopy: [] }));
      return dir;
    }

    it.each([
      ['a typescript block', ['```typescript', 'x', '```'], 'typescript'],
      ['a js block', ['```js', 'x', '```'], 'js'],
      ['a block without a language', ['```', 'x', '```'], 'unlabelled'],
      ['a tilde fence', ['~~~ts', 'x', '~~~'], 'ts'],
      ['a longer fence', ['````ts', 'x', '````'], 'ts'],
      ['an indented fence', ['  ```ts', 'x', '  ```'], 'ts'],
    ])('refuses %s without a title', (_name, fence, lang) => {
      const markdown = [...sh, ...fence].join('\n');
      expect(guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: bare(), requireTitles: true, known })).toEqual([
        `docs/recipe-x.md:4: the ${lang} block has no title — name its file with title="…".`,
      ]);
    });

    it('lets text and txt blocks be', () => {
      const markdown = [...sh, '```text', 'out', '```', '```txt', 'out', '```'].join('\n');
      expect(guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: bare(), requireTitles: true, known })).toEqual([]);
    });

    it.each([
      ['single quotes', "```ts title='modules/x/a.ts'"],
      ['a highlight range after the title', '```ts title="modules/x/a.ts" {1}'],
      ['no language', '```title="modules/x/a.ts"'],
      ['a tilde fence', '~~~ts title="modules/x/a.ts"'],
    ])('reads the title of a block with %s, so a block that differs is named', (_name, open) => {
      const close = open.startsWith('~') ? '~~~' : '```';
      const markdown = [...sh, open, 'x', close].join('\n');
      expect(guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: bare(), reference: 'apps/web-app', requireTitles: true, known })).toEqual([
        expect.stringContaining('docs/recipe-x.md:4 (modules/x/a.ts): the block is neither'),
      ]);
    });

    it.each([
      ['a list item', ['- item', '', '  ```ts', '  x', '  ```'], 4],
      ['a nested list item', ['- item', '  - inner', '', '    ```ts', '    x', '    ```'], 5],
      ['a quote', ['> ```ts', '> x', '> ```'], 3],
      ['an indented block', ['text', '', '    const a = 1;'], 3],
    ])('refuses an untitled block in %s', (_name, lines, line) => {
      const markdown = [...sh, '', ...lines].join('\n');
      const problems = guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: bare(), requireTitles: true, known });
      expect(problems).toEqual([expect.stringMatching(new RegExp(`^docs/recipe-x\\.md:\\d+: the (ts|unlabelled) block has no title`))]);
      expect(Number(/md:(\d+)/.exec(problems[0]!)![1])).toBeGreaterThanOrEqual(line);
    });

    it('does not let a fence it misses swallow the next block', () => {
      const markdown = [...sh, '```js', 'x', '```', '```ts title="modules/x/a.ts"', 'y', '```'].join('\n');
      expect(guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: bare(), requireTitles: true, known })).toEqual([
        'docs/recipe-x.md:4: the js block has no title — name its file with title="…".',
        expect.stringContaining('docs/recipe-x.md:7 (modules/x/a.ts): the block is neither'),
      ]);
    });

    it('refuses a ts block without a title, and lets an sh block be', () => {
      const dir = bare();
      const markdown = [...sh, '```ts', 'const a = 1;', '```'].join('\n');
      expect(guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: dir, requireTitles: true, known })).toEqual([
        'docs/recipe-x.md:4: the ts block has no title — name its file with title="…".',
      ]);
      expect(guideProblems(sh.join('\n'), { page: 'docs/recipe-x.md', overlay: dir, requireTitles: true, known })).toEqual([]);
      expect(guideProblems(markdown, { page: 'docs/recipe-x.md', overlay: dir, known })).toEqual([]);
    });
  });
});
