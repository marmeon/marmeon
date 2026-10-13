import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDE, guideProblems, knownCommands } from './first-app-guide.ts';
import { tempDir } from './test/temp-dir.js';

describe('the first-app guide', () => {
  it('shows exactly the files, the edits and the commands of the notes demo', () => {
    expect(guideProblems(readFileSync(GUIDE, 'utf8'))).toEqual([]);
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
    expect(guideProblems(good.join('\n'), overlay(), known)).toEqual([]);
  });

  it('accepts an excerpt of a file when the file is shown in full elsewhere', () => {
    expect(guideProblems([...good, '```ts title="modules/notes/a.ts"', 'two', '```'].join('\n'), overlay(), known)).toEqual([]);
  });

  it('names the guide line and the file of a block that differs from the demo', () => {
    const wrong = good.map((line) => (line === 'two' ? 'zwei' : line));
    expect(guideProblems(wrong.join('\n'), overlay(), known)).toEqual([
      'docs/first-app.md:4 (modules/notes/a.ts): the block is not part of examples/notes/files/modules/notes/a.ts.',
      'docs/first-app.md: examples/notes/files/modules/notes/a.ts is not shown in full.',
    ]);
  });

  it('refuses a titled block of a file the demo does not have', () => {
    const problems = guideProblems([...good, '```ts title="modules/notes/b.ts"', 'x', '```'].join('\n'), overlay(), known);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/first-app\.md:\d+ \(modules\/notes\/b\.ts\): the block is neither/);
  });

  it('names the line of a marmeon command that does not exist', () => {
    const typo = good.map((line) => (line === 'pnpm marmeon migrate' ? 'pnpm marmeon migrat' : line));
    expect(guideProblems(typo.join('\n'), overlay(), known).filter((problem) => problem.includes('not a command'))).toEqual(['docs/first-app.md:14: "marmeon migrat" is not a command of the framework.']);
  });

  it('names a missing edit and a missing or misplaced command', () => {
    const problems = guideProblems(['```sh', 'pnpm marmeon migrate', 'pnpm marmeon make:module notes', '```', '```ts title="modules/notes/a.ts"', 'one', 'two', 'three', '```'].join('\n'), overlay(), known);
    expect(problems).toEqual([
      'docs/first-app.md: the edit of layout.tsx that adds "y" is not shown.',
      'docs/first-app.md: the command "pnpm marmeon migrate" of commands.json is missing or out of order in the sh blocks.',
    ]);
  });
});
