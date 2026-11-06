import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAIN, mistakeLine, type ChainStepSpec } from '../apps/website/modules/site/chain.ts';
import type { Snippet } from '../apps/website/modules/site/snippets.ts';
import type { DemoTarget } from './notes-demo.ts';
import { SmokeError } from './pack-smoke.ts';
import { checkLanding, landingProblems } from './landing.ts';
import { tempDir } from './test/temp-dir.js';

describe('the landing of the repository', () => {
  it('has a source for every snippet and a typo that stands once in each step', () => {
    expect(landingProblems()).toEqual([]);
  });

  it('shows the seven typos of the chain, each with its misspelling', () => {
    expect(CHAIN.map((step) => step.id)).toEqual(['migration', 'row', 'repository', 'controller', 'route', 'props', 'form']);
    expect(CHAIN.map(mistakeLine)).toEqual([
      "table.strng('title', 120);",
      "export type Note = Row<'ntoes'>; // a row as read",
      ".where('user_ud', '=', userId)",
      "return this.view('notes/Show', { note: ctx.params.nte });",
      '<Link route="notes.indx">All notes</Link>',
      '<h1>{note.titel}</h1>',
      `{form.error('titel') && <small role="alert">{form.error('title')}</small>}`,
    ]);
  });
});

/** A repository with one file `apps/web-app/x.ts`, for `repo` sources. */
function repository(file = 'const a = 1;\n') {
  const root = tempDir('marmeon-landing-');
  const path = join(root, 'apps/web-app/x.ts');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file);
  return root;
}

const app = (extra: Partial<Snippet> & { source?: unknown } = {}) => ({ lang: 'ts', code: 'const a = 1;\n', source: { app: 'modules/a.ts' }, ...extra }) as Snippet;
const step = (extra: Partial<ChainStepSpec> = {}): ChainStepSpec => ({ id: 'row', title: 'Row', snippet: 'a', typo: { find: 'a', replace: 'b' }, ...extra }) as ChainStepSpec;

describe('landingProblems', () => {
  it('accepts snippets whose sources are fine', () => {
    const snippets = { a: app({ file: 'modules/a.ts' }), b: app({ file: 'm/2026_x_create.ts', source: { app: 'm/*_create.ts' } }), c: { lang: 'ts', code: 'const a = 1;\n', file: 'x.ts', source: { repo: 'apps/web-app/x.ts' } } } as Record<string, Snippet>;
    expect(landingProblems(repository(), snippets, [step()])).toEqual([]);
  });

  it('names a snippet without a source', () => {
    const { source: _, ...bare } = app();
    expect(landingProblems(repository(), { a: bare as Snippet }, [])).toEqual(['snippet "a": it has no source — name the file it is a piece of.']);
  });

  it('names a repo source that is missing or does not hold the code', () => {
    const snippets = { a: app({ source: { repo: 'apps/web-app/gone.ts' } }), b: app({ code: 'const z = 9;\n', source: { repo: 'apps/web-app/x.ts' } }) };
    expect(landingProblems(repository(), snippets, [])).toEqual(['snippet "a": the source apps/web-app/gone.ts does not exist.', 'snippet "b": the code is not in apps/web-app/x.ts.']);
  });

  it('names an app path with "..", an absolute one or two "*", and a label that does not fit', () => {
    const snippets = {
      a: app({ source: { app: '../x.ts' } }),
      b: app({ source: { app: '/x.ts' } }),
      c: app({ source: { app: 'm/*/*.ts' } }),
      d: app({ source: { app: 'm/*/x.ts' } }),
      e: app({ file: 'modules/other.ts' }),
      f: app({ file: 'z.ts', source: { repo: 'apps/web-app/x.ts' } }),
    };
    expect(landingProblems(repository(), snippets, [])).toEqual([
      'snippet "a": its app path must be relative and without "..".',
      'snippet "b": its app path must be relative and without "..".',
      'snippet "c": its app path may hold one "*", in the last segment.',
      'snippet "d": its app path may hold one "*", in the last segment.',
      'snippet "e": the file label "modules/other.ts" does not fit the source modules/a.ts.',
      'snippet "f": the file label "z.ts" does not fit the source apps/web-app/x.ts.',
    ]);
  });

  it('names a snippet that is not in its file of examples/landing/files or examples/notes/files, and skips a file an edit changes', () => {
    const root = repository();
    for (const [overlay, file, text] of [['landing', 'modules/a.ts', 'const a = 1;\n'], ['notes', 'modules/b.ts', 'const b = 1;\n'], ['notes', 'modules/c.ts', 'const c = 1;\n']] as const) {
      mkdirSync(join(root, 'examples', overlay, 'files/modules'), { recursive: true });
      writeFileSync(join(root, 'examples', overlay, 'files', file), text);
    }
    writeFileSync(join(root, 'examples/landing/edits.json'), JSON.stringify([{ file: 'modules/c.ts', find: 'c', replace: 'd' }]));
    const snippets = {
      a: app({ code: 'const a = 2;\n' }),
      b: app({ code: 'const b = 1;\n', source: { app: 'modules/b.ts' } }),
      b2: app({ code: 'const q = 1;\n', source: { app: 'modules/b.ts' } }),
      c: app({ code: 'const q = 1;\n', source: { app: 'modules/c.ts' } }),
    };
    expect(landingProblems(root, snippets, [])).toEqual([
      'snippet "a": the code is not in examples/landing/files/modules/a.ts: "const a = 2;" is not there.',
      'snippet "b2": the code is not in examples/notes/files/modules/b.ts: "const q = 1;" is not there.',
    ]);
  });

  it('names a chain step whose find is twice or not in the snippet, whose replace is its find, or whose snippet has a repo source', () => {
    const snippets = { a: app({ code: 'a a\na\n' }), r: { lang: 'ts', code: 'const a = 1;\n', source: { repo: 'apps/web-app/x.ts' } } } as Record<string, Snippet>;
    const chain = [step(), step({ id: 'route', typo: { find: 'zz', replace: 'y' } }), step({ id: 'props', typo: { find: 'a a', replace: 'a a' } }), step({ id: 'form', snippet: 'r' as never, typo: { find: 'const', replace: 'cnst' } }), step({ id: 'migration', snippet: 'missing' as never }), step({ id: 'controller', typo: { find: 'a\na', replace: 'b' } })];
    expect(landingProblems(repository(), snippets, chain)).toEqual([
      'chain step "row": "a" must stand exactly once in snippet "a", not 3 times.',
      'chain step "route": "zz" must stand exactly once in snippet "a", not 0 times.',
      'chain step "props": the typo replaces "a a" with itself.',
      'chain step "form": snippet "r" must have an app source, which the type check can run on.',
      'chain step "migration": there is no snippet "missing".',
      'chain step "controller": "a\\na" must sit on one line.',
    ]);
  });
});

/** A repository with the overlay `examples/landing` (a test file and nothing to edit) and a smoke app whose `modules/gen.ts` holds `generated`. */
function smoke(options: { generated?: string; extra?: string[]; tests?: string } = {}) {
  const repo = tempDir('marmeon-landing-');
  mkdirSync(join(repo, 'examples/landing/files/modules'), { recursive: true });
  writeFileSync(join(repo, 'examples/landing/files/modules/a.test.ts'), 'it();\n');
  writeFileSync(join(repo, 'examples/landing/edits.json'), '[]');
  writeFileSync(join(repo, 'examples/landing/commands.json'), JSON.stringify({ beforeCopy: [], afterCopy: ['marmeon route:types'] }));
  const app = tempDir('marmeon-landing-');
  mkdirSync(join(app, 'modules/dir'), { recursive: true });
  writeFileSync(join(app, 'modules/gen.ts'), options.generated ?? 'const g = 1;\n');
  for (const name of options.extra ?? []) writeFileSync(join(app, 'modules/dir', name), 'const g = 1;\n');
  const ran: string[] = [];
  const target: DemoTarget = {
    app,
    run(command, args) {
      const line = [command, ...args].join(' ');
      ran.push(line);
      return line.endsWith('run test --reporter=verbose') ? (options.tests ?? ' ✓ modules/a.test.ts > a\n Tests  1 passed (1)\n') : '';
    },
    buildWithoutEnv: () => '',
    serve: async () => {},
  };
  return { repo, target, ran };
}

const generated = (path = 'modules/gen.ts'): Record<string, Snippet> => ({ g: app({ code: 'const g = 1;\n', source: { app: path } }) });

describe('checkLanding', () => {
  it('lays the overlay on the app, finds each snippet in its file and runs the tools', () => {
    const { repo, target, ran } = smoke({ extra: ['x_one.ts'] });
    checkLanding(target, 'pnpm', repo, { ...generated(), star: app({ code: 'const g = 1;\n', source: { app: 'modules/dir/*_one.ts' } }) });
    expect(ran).toEqual(['pnpm exec marmeon route:types', 'pnpm run test --reporter=verbose', 'pnpm run typecheck', 'pnpm run lint --deny-warnings']);
  });

  it('names a snippet that is not in the app file', () => {
    const { repo, target } = smoke({ generated: 'const g = 2;\n' });
    expect(() => checkLanding(target, 'pnpm', repo, generated())).toThrow(new SmokeError('snippet "g": the code is not in modules/gen.ts: "const g = 1;" is not there.'));
  });

  it('names a snippet whose file is missing, and a "*" that matches two files or none', () => {
    const { repo, target } = smoke({ extra: ['x_one.ts', 'y_one.ts'] });
    expect(() => checkLanding(target, 'pnpm', repo, generated('modules/gone.ts'))).toThrow(/snippet "g": modules\/gone\.ts must match exactly one file of the app, it matches 0\./);
    expect(() => checkLanding(target, 'pnpm', repo, generated('modules/dir/*_one.ts'))).toThrow(/snippet "g": modules\/dir\/\*_one\.ts must match exactly one file of the app, it matches 2 \(/);
    expect(() => checkLanding(target, 'pnpm', repo, generated('modules/dir/*_two.ts'))).toThrow(/it matches 0\./);
  });

  it('fails when a test file of the overlay did not run or the tests did not pass', () => {
    expect(() => checkLanding(smoke({ tests: ' Tests  1 passed (1)\n' }).target, 'pnpm', smoke().repo, generated())).toThrow(/did not run modules\/a\.test\.ts/);
    const { repo, target } = smoke({ tests: ' ✓ modules/a.test.ts > a\n Tests  1 failed (1)\n' });
    expect(() => checkLanding(target, 'pnpm', repo, generated())).toThrow(/tests did not pass/);
  });

  it('refuses a snippet whose source is wrong before it touches the app', () => {
    const { repo, target, ran } = smoke();
    expect(() => checkLanding(target, 'pnpm', repo, generated('../x.ts'))).toThrow(/snippet "g": its app path must be relative/);
    expect(ran).toEqual([]);
  });
});
