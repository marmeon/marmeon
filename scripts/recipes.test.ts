import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DemoTarget } from './notes-demo.ts';
import { SmokeError } from './pack-smoke.ts';
import { checkRecipes, readRecipes, recipeProblems } from './recipes.ts';
import { tempDir } from './test/temp-dir.js';

describe('the recipes of the repository', () => {
  it('have a page for every overlay and an overlay for every page, and show only what the overlay or the reference holds', () => {
    expect(recipeProblems()).toEqual([]);
  });

  it('are the ones in docs/', () => {
    const pages = readdirSync(new URL('../docs', import.meta.url)).filter((file) => file.startsWith('recipe-'));
    expect(readRecipes().map((recipe) => recipe.page)).toEqual(pages.map((file) => `docs/${file}`));
  });
});

const COMMANDS = JSON.stringify({ beforeCopy: ['marmeon make:thing Thing'], afterCopy: [] });

/** A repository of one recipe `thing`: its page, its overlay and, in `reference/`, one file the page may show. */
function repository(options: { page?: string | null; overlay?: boolean; recipe?: unknown } = {}) {
  const root = tempDir('marmeon-recipes-');
  const { overlay = true, recipe = { page: 'docs/recipe-thing.md', reference: 'reference' } } = options;
  const page = options.page === undefined ? ['# Thing', '', '```sh', 'pnpm marmeon make:thing Thing', '```', '', '```ts title="modules/things/a.ts"', 'const a = 1;', '```', ''].join('\n') : options.page;
  mkdirSync(join(root, 'docs'), { recursive: true });
  if (page !== null) writeFileSync(join(root, 'docs/recipe-thing.md'), page);
  mkdirSync(join(root, 'reference/modules/things'), { recursive: true });
  writeFileSync(join(root, 'reference/modules/things/a.ts'), 'const a = 1;\nconst b = 2;\n');
  if (overlay) {
    mkdirSync(join(root, 'examples/recipes/thing'), { recursive: true });
    writeFileSync(join(root, 'examples/recipes/thing/recipe.json'), JSON.stringify(recipe));
    writeFileSync(join(root, 'examples/recipes/thing/edits.json'), '[]');
    writeFileSync(join(root, 'examples/recipes/thing/commands.json'), COMMANDS);
  }
  return root;
}

describe('recipeProblems', () => {
  // The command of the page is not a command of this framework's packages, so the fake ones are the only problems of these pages.
  const withoutCommandProblems = (problems: string[]) => problems.filter((problem) => !problem.includes('is not a command of the framework'));

  it('accepts a page that matches its overlay and reference', () => {
    expect(withoutCommandProblems(recipeProblems(repository()))).toEqual([]);
  });

  it('names a page without an overlay', () => {
    expect(recipeProblems(repository({ overlay: false }))).toEqual(['docs/recipe-thing.md: there is no examples/recipes/thing for this recipe.']);
  });

  it('names an overlay without a page', () => {
    expect(recipeProblems(repository({ page: null }))).toEqual(['examples/recipes/thing: there is no docs/recipe-thing.md for this recipe.']);
  });

  it('refuses a recipe.json with another key, another page or a reference that leaves the repository', () => {
    for (const recipe of [
      { page: 'docs/recipe-thing.md', extra: true },
      { page: 'docs/recipe-other.md' },
      { page: 'docs/recipe-thing.md', reference: '../x' },
      { page: 'docs/recipe-thing.md', reference: '/etc' },
      { page: 'docs/recipe-thing.md', reference: 7 },
    ]) {
      const problems = recipeProblems(repository({ recipe }));
      expect(problems.filter((problem) => problem.includes('recipe.json')), JSON.stringify(recipe)).toHaveLength(1);
    }
  });

  it('names a titled block that is not in the reference, and a ts block without a title', () => {
    const page = ['```sh', 'pnpm marmeon make:thing Thing', '```', '```ts title="modules/things/a.ts"', 'const a = 2;', '```', '```ts', 'const c = 3;', '```'].join('\n');
    expect(withoutCommandProblems(recipeProblems(repository({ page })))).toEqual([
      'docs/recipe-thing.md:4 (modules/things/a.ts): the block is not part of reference/modules/things/a.ts.',
      'docs/recipe-thing.md:7: the ts block has no title — name its file with title="…".',
    ]);
  });
});

/** The smoke app of a recipe `thing`: what its commands write, and the answers of the tools the check reads. */
function smoke(options: { appFile?: string; check?: unknown; recipesInDocs?: string[]; tests?: string } = {}) {
  const repo = repository();
  const app = tempDir('marmeon-recipes-app-');
  mkdirSync(join(app, 'modules/things'), { recursive: true });
  writeFileSync(join(app, 'modules/things/a.ts'), options.appFile ?? 'const a = 1;\nconst b = 2;\n');
  writeFileSync(join(app, 'modules/things/a.test.ts'), '');
  const ran: string[] = [];
  const check = options.check ?? { format: 1, ok: true, checks: [{ name: 'raw-sql', status: 'passed', problems: [] }, { name: 'throttle', status: 'passed', problems: [] }] };
  const target: DemoTarget = {
    app,
    run(command, args) {
      const line = [command, ...args].join(' ');
      ran.push(line);
      if (line.endsWith('check --json --skip=readiness')) return JSON.stringify(check);
      if (line.endsWith('docs --json')) return JSON.stringify({ sections: [{ title: 'Recipes', pages: (options.recipesInDocs ?? ['recipe-thing']).map((slug) => ({ slug })) }] });
      if (line.endsWith('run test --reporter=verbose')) return options.tests ?? ' ✓ modules/things/a.test.ts > a\n Tests  1 passed (1)\n';
      return '';
    },
    buildWithoutEnv: () => {
      ran.push('build');
      return '';
    },
    serve: async () => {},
  };
  return { repo, target, ran };
}

describe('checkRecipes', () => {
  it('lays the overlay on the app, compares the blocks and runs the tools', () => {
    const { repo, target, ran } = smoke();
    checkRecipes(target, 'pnpm', repo);
    expect(ran).toEqual([
      'pnpm exec marmeon make:thing Thing',
      'pnpm run test --reporter=verbose',
      'pnpm run typecheck',
      'pnpm run lint --deny-warnings',
      'build',
      'pnpm exec marmeon check --json --skip=readiness',
      'pnpm exec marmeon docs --json',
    ]);
  });

  it('names the page, the line and the file of a block that is not in the app', () => {
    const { repo, target } = smoke({ appFile: 'const a = 2;\n' });
    expect(() => checkRecipes(target, 'pnpm', repo)).toThrow(new SmokeError('docs/recipe-thing.md:7 (modules/things/a.ts): the block is not in the app\'s file.'));
  });

  it('fails when a test file of a recipe did not run', () => {
    const { repo, target } = smoke({ tests: ' Tests  1 passed (1)\n' });
    expect(() => checkRecipes(target, 'pnpm', repo)).toThrow(/did not run modules\/things\/a\.test\.ts/);
  });

  it('fails on a finding of throttle in marmeon check --json', () => {
    const { repo, target } = smoke({ check: { ok: true, checks: [{ name: 'throttle', status: 'passed', problems: [{ message: 'POST /x can be called by anyone' }] }] } });
    expect(() => checkRecipes(target, 'pnpm', repo)).toThrow(/throttle found/);
  });

  it('fails when marmeon check did not pass', () => {
    const { repo, target } = smoke({ check: { ok: false, checks: [] } });
    expect(() => checkRecipes(target, 'pnpm', repo)).toThrow(SmokeError);
  });

  it('fails when marmeon docs does not list the recipe under "Recipes"', () => {
    const { repo, target } = smoke({ recipesInDocs: ['installation'] });
    expect(() => checkRecipes(target, 'pnpm', repo)).toThrow(/lists no "recipe-thing" under "Recipes"/);
  });
});
