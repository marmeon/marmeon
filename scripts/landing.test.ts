import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAIN, mistakeLine, type ChainStepSpec } from '../apps/website/modules/site/chain.ts';
import type { Snippet } from '../apps/website/modules/site/snippets.ts';
import type { DemoTarget } from './notes-demo.ts';
import { SmokeError } from './pack-smoke.ts';
import { checkLanding, checkTypo, landingProblems, withoutCommentLines } from './landing.ts';
import { tempDir } from './test/temp-dir.js';

describe('the landing of the repository', () => {
  it('has a source for every snippet and a typo that stands once in each step', () => {
    expect(landingProblems()).toEqual([]);
  });

  it('shows the seven typos of the chain, each with its misspelling', () => {
    expect(CHAIN.map((step) => step.id)).toEqual(['migration', 'row', 'repository', 'controller', 'route', 'props', 'form']);
    expect(CHAIN.map(mistakeLine)).toEqual([
      "table.strng('title', 120);",
      "export type Note = Row<'ntoes'>;",
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
const step = (extra: Partial<ChainStepSpec> = {}): ChainStepSpec => ({ id: 'row', title: 'Row', snippet: 'a', typo: { find: 'a', replace: 'b' }, error: { code: 'TS2551', message: 'm' }, ...extra }) as ChainStepSpec;

describe('withoutCommentLines', () => {
  it('drops whole-line // comments, block comments over several lines and JSDoc, and keeps indentation', () => {
    const text = ['// head', 'const a = 1;', '  // indented', '  /** one line */', '  /**', '   * Many', '   * lines.', '   */', '  const b = 2;', '/* x', 'y */', 'const c = 3;', ''].join('\n');
    expect(withoutCommentLines(text, 'a.ts')).toBe('const a = 1;\n  const b = 2;\nconst c = 3;\n');
  });

  it('keeps a comment after code, a // inside a string and code after a closed block comment', () => {
    const text = ["const url = 'http://example.com'; // the site", "const note = '// not a comment';", '/* c */ const d = 4;', '  /* c */', 'const e = 5; /* trailing */', ''].join('\n');
    expect(withoutCommentLines(text, 'a.ts')).toBe(["const url = 'http://example.com'; // the site", "const note = '// not a comment';", '/* c */ const d = 4;', 'const e = 5; /* trailing */', ''].join('\n'));
  });

  it('drops nothing inside a template literal that runs over several lines, so a fake comment cannot swallow code', () => {
    const text = ['const sql = `', '/* glob', '`;', 'deleteEverything();', 'const done = true; // */', 'next();', ''].join('\n');
    expect(withoutCommentLines(text, 'a.ts')).toBe(text);
    expect(withoutCommentLines(['const t = `a \\` still', '// in the template', '`;', '// a comment', 'x;', ''].join('\n'), 'a.ts')).toBe(['const t = `a \\` still', '// in the template', '`;', 'x;', ''].join('\n'));
  });

  it('is not fooled by a backtick in a ${} expression or by a regular expression with a quote or a backtick', () => {
    const lines = (...parts: string[]) => [...parts, ''].join('\n');
    // The template stays open over `/* x`, so that line is text; `// */` after the closing backtick is a real comment.
    expect(withoutCommentLines(lines('const sql = `${\'`\'}', '/* x', '`;', 'code();', '// */', 'next();'), 'a.ts')).toBe(lines('const sql = `${\'`\'}', '/* x', '`;', 'code();', 'next();'));
    expect(withoutCommentLines(lines('const quote = /\'/;', '// gone', 'code();'), 'a.ts')).toBe(lines('const quote = /\'/;', 'code();'));
    expect(withoutCommentLines(lines('const tick = /\\`/;', '/* gone */', 'code();'), 'a.ts')).toBe(lines('const tick = /\\`/;', 'code();'));
  });

  it('keeps a // line inside JSX text, which is text and no comment', () => {
    const text = ['export const a = (', '  <p>', '    // not a comment', '  </p>', ');', ''].join('\n');
    expect(withoutCommentLines(text, 'a.tsx')).toBe(text);
  });

  it('refuses a file that does not parse, naming it', () => {
    expect(() => withoutCommentLines('const a = ;\n// c\n', 'broken.ts')).toThrow(/^broken\.ts: oxc-parser cannot read it/);
  });

  it('keeps blank lines, so a snippet over a dropped comment needs the blank line of the file', () => {
    expect(withoutCommentLines('a;\n\n// c\nb;\n', 'a.ts')).toBe('a;\n\nb;\n');
  });
});

describe('landingProblems', () => {
  it('refuses a source that does not parse, and judges a fragment that does not parse by its text', () => {
    const root = repository('const a = ;\n// c\n');
    const snippets = {
      broken: { lang: 'ts', code: 'const a = ;\n', source: { repo: 'apps/web-app/x.ts' } },
      slashes: { lang: 'ts', code: 'foo(\n// c\n', source: { app: 'modules/a.ts' } },
      stars: { lang: 'ts', code: 'foo(\n * c\n', source: { app: 'modules/a.ts' } },
      plain: { lang: 'ts', code: 'foo(\n', source: { app: 'modules/a.ts' } },
    } as Record<string, Snippet>;
    const problems = landingProblems(root, snippets, []);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^snippet "broken": .*x\.ts: oxc-parser cannot read it/);
    expect(problems.slice(1)).toEqual([
      'snippet "slashes": it has a comment line — the landing shows code without comments; the source file may keep them.',
      'snippet "stars": it has a comment line — the landing shows code without comments; the source file may keep them.',
    ]);
  });

  it('accepts a snippet whose line ends with a comment, when the source has the same line', () => {
    const root = repository('const a = 1; // one\nconst b = 2;\n');
    const snippets = { a: { lang: 'ts', code: 'const a = 1; // one\nconst b = 2;\n', source: { repo: 'apps/web-app/x.ts' } } } as Record<string, Snippet>;
    expect(landingProblems(root, snippets, [])).toEqual([]);
  });

  it('names a snippet with a comment line, and compares a snippet with its source without the source\'s comment lines', () => {
    const root = repository('// why\nconst a = 1;\n/** more */\nconst b = 2;\n');
    const snippets = {
      fine: { lang: 'ts', code: 'const a = 1;\nconst b = 2;\n', source: { repo: 'apps/web-app/x.ts' } },
      commented: { lang: 'ts', code: '// why\nconst a = 1;\n', source: { repo: 'apps/web-app/x.ts' } },
      block: { lang: 'ts', code: '/**\n * c\n */\nconst a = 1;\n', source: { app: 'modules/a.ts' } },
    } as Record<string, Snippet>;
    expect(landingProblems(root, snippets, [])).toEqual([
      'snippet "commented": it has a comment line — the landing shows code without comments; the source file may keep them.',
      'snippet "commented": the code is not in apps/web-app/x.ts.',
      'snippet "block": it has a comment line — the landing shows code without comments; the source file may keep them.',
    ]);
  });

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

  it('names a battery excerpt of fewer than 4 or more than 8 lines, and lets other snippets be any length', () => {
    const lines = (count: number) => `${Array.from({ length: count }, (_, index) => `const a${index} = 1;`).join('\n')}\n`;
    const snippets = { batteryShort: app({ code: lines(3) }), batteryLong: app({ code: lines(9) }), batteryFour: app({ code: lines(4) }), batteryEight: app({ code: lines(8) }), long: app({ code: lines(12) }) };
    const root = repository();
    mkdirSync(join(root, 'examples/notes/files/modules'), { recursive: true });
    writeFileSync(join(root, 'examples/notes/files/modules/a.ts'), `${lines(12)}`);
    expect(landingProblems(root, snippets, [])).toEqual(['snippet "batteryShort": a battery excerpt has 4 to 8 lines, not 3.', 'snippet "batteryLong": a battery excerpt has 4 to 8 lines, not 9.']);
  });

  it('names a chain step whose error has no TS code or no one-line message', () => {
    const snippets = { a: app({ code: 'a a\n' }) };
    const typo = { find: 'a a', replace: 'b' };
    const chain = [
      step({ id: 'row', typo, error: { code: '2322' as never, message: 'm' } }),
      step({ id: 'route', typo, error: { code: 'TS2322', message: '' } }),
      step({ id: 'props', typo, error: { code: 'TS2322', message: 'a\nb' } }),
    ];
    expect(landingProblems(repository(), snippets, chain)).toEqual([
      'chain step "row": the error code must look like TS2322.',
      "chain step \"route\": the error message must be the first line of the compiler's message, not empty.",
      "chain step \"props\": the error message must be the first line of the compiler's message, not empty.",
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
  const { root: app } = project();
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
  it('lays the overlay on the app, finds each snippet in its file and runs the tools', async () => {
    const { repo, target, ran } = smoke({ extra: ['x_one.ts'] });
    await checkLanding(target, 'pnpm', repo, { ...generated(), star: app({ code: 'const g = 1;\n', source: { app: 'modules/dir/*_one.ts' } }) }, []);
    expect(ran).toEqual(['pnpm exec marmeon route:types', 'pnpm run test --reporter=verbose', 'pnpm run typecheck', 'pnpm run lint --deny-warnings']);
  });

  it('proves each typo of the chain on the app and type-checks it again', async () => {
    const { repo, target } = smoke();
    const snippets = { a: app({ code: 'value.length;\n', source: { app: 'a.ts' } }) };
    await checkLanding(target, 'pnpm', repo, snippets, [TYPO]);
    await expect(checkLanding(target, 'pnpm', repo, snippets, [{ ...TYPO, error: { code: 'TS2551', message: 'other' } }])).rejects.toThrow(/chain step "row" \(a\.ts:2\)/);
  });

  it('fails when the app does not type-check at the end', async () => {
    const { repo, target } = smoke();
    writeFileSync(join(target.app, 'a.ts'), "const value: string = 1;\n");
    await expect(checkLanding(target, 'pnpm', repo, generated(), [])).rejects.toThrow(/does not type-check after the typos were put back:\na\.ts\(1,7\): TS2322/);
  });

  it('finds a snippet in an app file that has comment lines around it', async () => {
    const { repo, target } = smoke({ generated: '// why\nconst g = 1;\n/** more */\n' });
    await checkLanding(target, 'pnpm', repo, generated(), []);
  });

  it('names a snippet that is not in the app file', async () => {
    const { repo, target } = smoke({ generated: 'const g = 2;\n' });
    await expect(checkLanding(target, 'pnpm', repo, generated(), [])).rejects.toThrow(new SmokeError('snippet "g": the code is not in modules/gen.ts: "const g = 1;" is not there.'));
  });

  it('names a snippet whose file is missing, and a "*" that matches two files or none', async () => {
    const { repo, target } = smoke({ extra: ['x_one.ts', 'y_one.ts'] });
    await expect(checkLanding(target, 'pnpm', repo, generated('modules/gone.ts'), [])).rejects.toThrow(/snippet "g": modules\/gone\.ts must match exactly one file of the app, it matches 0\./);
    await expect(checkLanding(target, 'pnpm', repo, generated('modules/dir/*_one.ts'), [])).rejects.toThrow(/snippet "g": modules\/dir\/\*_one\.ts must match exactly one file of the app, it matches 2 \(/);
    await expect(checkLanding(target, 'pnpm', repo, generated('modules/dir/*_two.ts'), [])).rejects.toThrow(/it matches 0\./);
  });

  it('fails when a test file of the overlay did not run or the tests did not pass', async () => {
    await expect(checkLanding(smoke({ tests: ' Tests  1 passed (1)\n' }).target, 'pnpm', smoke().repo, generated(), [])).rejects.toThrow(/did not run modules\/a\.test\.ts/);
    const { repo, target } = smoke({ tests: ' ✓ modules/a.test.ts > a\n Tests  1 failed (1)\n' });
    await expect(checkLanding(target, 'pnpm', repo, generated(), [])).rejects.toThrow(/tests did not pass/);
  });

  it('refuses a snippet whose source is wrong before it touches the app', async () => {
    const { repo, target, ran } = smoke();
    await expect(checkLanding(target, 'pnpm', repo, generated('../x.ts'), [])).rejects.toThrow(/snippet "g": its app path must be relative/);
    expect(ran).toEqual([]);
  });
});

/** A project of one file, `a.ts`, that type-checks with the TypeScript of this repository. */
function project() {
  const root = tempDir('marmeon-landing-');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(realpathSync(join(import.meta.dirname, '../node_modules/typescript')), join(root, 'node_modules/typescript'), 'dir');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', types: [] }, include: ['a.ts'] }));
  const original = "const value: string = 'x';\nvalue.length;\n";
  writeFileSync(join(root, 'a.ts'), original);
  return { root, original };
}

const TYPO: ChainStepSpec = { id: 'row', title: 'Row', snippet: 'a' as never, typo: { find: 'value.length', replace: 'value.lenght' }, error: { code: 'TS2551', message: "Property 'lenght' does not exist on type 'string'. Did you mean 'length'?" } };

describe('checkTypo', () => {
  it('accepts a typo that fails with the named error on its line, and puts the file back', async () => {
    const { root, original } = project();
    await checkTypo(root, 'a.ts', TYPO);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(original);
  });

  it('refuses a typo that compiles', async () => {
    const { root, original } = project();
    const step = { ...TYPO, typo: { find: 'value.length', replace: 'value.length;' } };
    await expect(checkTypo(root, 'a.ts', step)).rejects.toThrow(new SmokeError('chain step "row" (a.ts:2): the typo compiles.'));
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(original);
  });

  it('refuses a typo with two errors and lists them', async () => {
    const { root, original } = project();
    const step = { ...TYPO, typo: { find: "const value: string = 'x';", replace: "const value: string = 1;\nvalue.lenght;" } };
    await expect(checkTypo(root, 'a.ts', step)).rejects.toThrow(/expected one error, TS2551 .*, on line 1; the compiler said:\na\.ts\(1,7\): TS2322 .*\na\.ts\(2,7\): TS2551/);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(original);
  });

  it('shows the real message when the stored one is wrong', async () => {
    const { root, original } = project();
    const step = { ...TYPO, error: { code: 'TS2551', message: 'something else' } } as const satisfies Partial<ChainStepSpec>;
    await expect(checkTypo(root, 'a.ts', step)).rejects.toThrow(/the compiler said:\na\.ts\(2,7\): TS2551 Property 'lenght' does not exist on type 'string'\. Did you mean 'length'\?/);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(original);
  });

  it('refuses the right error on another line than the typo', async () => {
    const { root } = project();
    // `find` is on line 1; the error it causes is on line 2.
    writeFileSync(join(root, 'a.ts'), "let value = 'x';\nvalue.length;\n");
    const step = { ...TYPO, typo: { find: "let value = 'x';", replace: 'let value = 1;' }, error: { code: 'TS2339' as const, message: "Property 'length' does not exist on type 'number'." } };
    await expect(checkTypo(root, 'a.ts', step)).rejects.toThrow(/expected one error, TS2339 .*, on line 1; the compiler said:\na\.ts\(2,7\): TS2339/);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe("let value = 'x';\nvalue.length;\n");
  });

  it('refuses the right error in another file than the typo', async () => {
    const { root } = project();
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', types: [] }, include: ['a.ts', 'b.ts'] }));
    // Both files are scripts and share `value`: the error lands in b.ts on the line number of `find`.
    writeFileSync(join(root, 'a.ts'), "let value = 'x';\n");
    writeFileSync(join(root, 'b.ts'), 'value.length;\n');
    const step = { ...TYPO, typo: { find: "let value = 'x';", replace: 'let value = 1;' }, error: { code: 'TS2339' as const, message: "Property 'length' does not exist on type 'number'." } };
    await expect(checkTypo(root, 'a.ts', step)).rejects.toThrow(/on line 1; the compiler said:\nb\.ts\(1,7\): TS2339/);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe("let value = 'x';\n");
  });

  it('refuses a find that is not exactly once in the file', async () => {
    const { root } = project();
    await expect(checkTypo(root, 'a.ts', { ...TYPO, typo: { find: 'value', replace: 'v' } })).rejects.toThrow(/must stand exactly once in a\.ts, not 2 times/);
  });
});
