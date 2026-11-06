import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAIN, mistakeLine, type ChainStepSpec } from '../apps/website/modules/site/chain.ts';
import type { Snippet } from '../apps/website/modules/site/snippets.ts';
import { landingProblems } from './landing.ts';
import { tempDir } from './test/temp-dir.js';

describe('the landing of the repository', () => {
  it('has a source for every snippet and a typo that stands once in each step', () => {
    expect(landingProblems()).toEqual([]);
  });

  it('shows the seven typos of the chain, each with its misspelling', () => {
    expect(CHAIN.map((step) => step.id)).toEqual(['migration', 'row', 'repository', 'controller', 'route', 'props', 'form']);
    expect(CHAIN.map(mistakeLine)).toEqual([
      "table.strng('title', 200);",
      "export type Note = Row<'ntoes'>; // a row as read",
      "return this.query().selectAll().where('user_ud', '=', userId).orderBy('updated_at', 'desc').limit(10).execute();",
      "return this.view('notes/Show', { note: ctx.params.nte });",
      '<Link route="notes.indx">All notes</Link>',
      '<h1>{note.titel}</h1>',
      'form.errors.titel',
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

  it('names a chain step whose find is twice or not in the snippet, whose replace is its find, or whose snippet has a repo source', () => {
    const snippets = { a: app({ code: 'a a\n' }), r: { lang: 'ts', code: 'const a = 1;\n', source: { repo: 'apps/web-app/x.ts' } } } as Record<string, Snippet>;
    const chain = [step(), step({ id: 'route', typo: { find: 'zz', replace: 'y' } }), step({ id: 'props', typo: { find: 'a a', replace: 'a a' } }), step({ id: 'form', snippet: 'r' as never, typo: { find: 'const', replace: 'cnst' } })];
    expect(landingProblems(repository(), snippets, chain)).toEqual([
      'chain step "row": "a" must stand exactly once in snippet "a", not 2 times.',
      'chain step "route": "zz" must stand exactly once in snippet "a", not 0 times.',
      'chain step "props": the typo replaces "a a" with itself.',
      'chain step "form": snippet "r" must have an app source, which the type check can run on.',
    ]);
  });
});
