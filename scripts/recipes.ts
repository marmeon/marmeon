/**
 * The recipes (`docs/recipe-<name>.md`) and their checks. A recipe has a directory `examples/recipes/<name>` in the format of
 * `examples/notes` (`files/` optional, `edits.json`, `commands.json`) and a `recipe.json`:
 *
 *   { "page": "docs/recipe-<name>.md", "reference": "apps/web-app" }
 *
 * `reference` is optional: a directory of this repository whose files a titled block of the page may show, for what a generator
 * writes and the overlay therefore does not hold. `recipeProblems` compares pages and overlays (`pnpm test`); `checkRecipes`
 * lays the overlays on the smoke app and compares the app (`pnpm pack:smoke`). Functions for those two, no command of their own.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks, guideProblems, type Block } from './guides.ts';
import { applyOverlay, type DemoTarget } from './notes-demo.ts';
import { SmokeError } from './pack-smoke.ts';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));

/** `examples/recipes` of this repository. */
export const RECIPES = fileURLToPath(new URL('../examples/recipes', import.meta.url));

export interface Recipe {
  /** The directory's name; the page is `docs/recipe-<name>.md`. */
  readonly name: string;
  /** The overlay's directory. */
  readonly overlay: string;
  /** The page, relative to the repository. */
  readonly page: string;
  /** A directory of the repository, relative to its root. */
  readonly reference?: string;
}

/** Checks `recipe.json` of one recipe directory; throws a `SmokeError` that names the file. */
function readRecipe(recipes: string, name: string): Recipe {
  const path = join(recipes, name, 'recipe.json');
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SmokeError(`${path}: ${(error as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new SmokeError(`${path}: must be an object { page, reference? }.`);
  const extra = Object.keys(json).filter((key) => key !== 'page' && key !== 'reference');
  if (extra.length > 0) throw new SmokeError(`${path}: unknown ${extra.length === 1 ? 'key' : 'keys'} ${extra.map((key) => JSON.stringify(key)).join(', ')} — only "page" and "reference" are read.`);
  const { page, reference } = json as { page?: unknown; reference?: unknown };
  if (page !== `docs/recipe-${name}.md`) throw new SmokeError(`${path}: "page" must be "docs/recipe-${name}.md", the page of the directory's name.`);
  if (reference !== undefined) {
    if (typeof reference !== 'string' || reference === '' || isAbsolute(reference) || reference.split('/').includes('..')) {
      throw new SmokeError(`${path}: "reference" must be a path inside the repository, not absolute and without "..".`);
    }
    return { name, overlay: join(recipes, name), page, reference };
  }
  return { name, overlay: join(recipes, name), page };
}

function load(repository: string): { recipes: Recipe[]; problems: string[] } {
  const directory = join(repository, 'examples/recipes');
  const recipes: Recipe[] = [];
  const problems: string[] = [];
  const names = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
  for (const name of names) {
    try {
      recipes.push(readRecipe(directory, name));
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  const docs = join(repository, 'docs');
  const pages = existsSync(docs) ? readdirSync(docs).filter((file) => /^recipe-.+\.md$/.test(file)).sort() : [];
  for (const file of pages) {
    if (!names.includes(file.slice('recipe-'.length, -'.md'.length))) problems.push(`docs/${file}: there is no examples/recipes/${file.slice('recipe-'.length, -'.md'.length)} for this recipe.`);
  }
  for (const name of names) {
    if (!pages.includes(`recipe-${name}.md`)) problems.push(`examples/recipes/${name}: there is no docs/recipe-${name}.md for this recipe.`);
  }
  return { recipes, problems };
}

/** Every recipe of the repository, by directory name. Throws a `SmokeError` for a `recipe.json` that is wrong. */
export function readRecipes(repository: string = REPOSITORY): Recipe[] {
  const { recipes, problems } = load(repository);
  const broken = problems.find((problem) => problem.includes('recipe.json'));
  if (broken) throw new SmokeError(broken);
  return recipes;
}

/**
 * What differs between the recipes' pages and their overlays, one message each: a `recipe.json` that is wrong, a page without
 * an overlay or an overlay without a page, and everything `guideProblems` finds (every `ts`, `tsx` and `json` block with a title
 * that is a piece of an overlay file, of an edit or of a file below `reference`). Empty when they agree.
 */
export function recipeProblems(repository: string = REPOSITORY): string[] {
  const { recipes, problems } = load(repository);
  for (const recipe of recipes) {
    const file = join(repository, recipe.page);
    if (!existsSync(file)) continue;
    problems.push(
      ...guideProblems(readFileSync(file, 'utf8'), { page: recipe.page, overlay: recipe.overlay, reference: recipe.reference, requireTitles: true, root: repository }),
    );
  }
  return problems;
}

/** The files `*.test.ts` below `dir`, relative to `app`. */
function testFiles(app: string, dir: string): string[] {
  const path = join(app, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name).slice(app.length + 1));
}

/** The module directories (`modules/<name>`) the titled blocks of a page write to. */
function modulesOf(titled: readonly Block[]): string[] {
  return [...new Set(titled.flatMap((block) => /^(modules\/[^/]+)\//.exec(block.title!)?.[1] ?? []))];
}

interface CheckReport {
  readonly ok?: unknown;
  readonly checks?: readonly { name?: unknown; status?: unknown; problems?: readonly unknown[] }[];
}

/** The checks a recipe's code must not trip: a finding in one of them is the recipe's fault. */
const GUARDED = ['raw-sql', 'inner-html', 'throttle'];

/**
 * The recipes on the smoke app (the notes demo may be on it already): every overlay applied; every titled block of every page
 * word for word in the app's file of that name (so what a generator wrote is checked as well); the tests of the recipes' modules
 * run; type check; lint; build; `marmeon check --json --skip=readiness` passes with no finding in `raw-sql`, `inner-html` or `throttle`;
 * and `marmeon docs --json` lists every recipe under "Recipes". A difference is a `SmokeError` with the page and the line.
 */
export function checkRecipes(smoke: DemoTarget, pm: 'pnpm', repository: string = REPOSITORY, recipes: readonly Recipe[] = readRecipes(repository)): void {
  const marmeon = (...args: string[]) => smoke.run(pm, ['exec', 'marmeon', ...args]);
  const modules: string[] = [];
  const slugs: string[] = [];
  for (const recipe of recipes) {
    applyOverlay(smoke.app, (args) => void marmeon(...args), recipe.overlay);
    const titled = blocks(readFileSync(join(repository, recipe.page), 'utf8')).filter((block) => block.title !== undefined);
    for (const block of titled) {
      const where = `${recipe.page}:${block.line} (${block.title})`;
      if (isAbsolute(block.title!) || block.title!.split('/').includes('..')) throw new SmokeError(`${where}: the title must be a path inside the app.`);
      const file = join(smoke.app, block.title!);
      if (!existsSync(file)) throw new SmokeError(`${where}: the app has no such file after the recipe's commands.`);
      if (!readFileSync(file, 'utf8').includes(block.text)) throw new SmokeError(`${where}: the block is not in the app's file.`);
    }
    modules.push(...modulesOf(titled));
    slugs.push(recipe.page.slice('docs/'.length, -'.md'.length));
  }

  const expected = [...new Set(modules)].flatMap((dir) => testFiles(smoke.app, dir));
  if (expected.length === 0 && recipes.length > 0) throw new SmokeError('the recipes brought no test file (modules/<name>/*.test.ts) into the app.');
  const tests = smoke.run(pm, ['run', 'test', '--reporter=verbose']);
  for (const file of expected) if (!tests.includes(file)) throw new SmokeError(`vitest did not run ${file}, a test of a recipe:\n${tests}`);
  if (!/Tests\s+\d+ passed/.test(tests)) throw new SmokeError(`the recipes' tests did not pass:\n${tests}`);
  smoke.run(pm, ['run', 'typecheck']);
  smoke.run(pm, ['run', 'lint', '--deny-warnings']);
  // The later steps start the app: its build has to hold the recipes' modules, as the build of the notes demo held the demo's.
  smoke.buildWithoutEnv();

  let report: CheckReport;
  try {
    report = JSON.parse(marmeon('check', '--json', '--skip=readiness')) as CheckReport;
  } catch (error) {
    throw new SmokeError(`marmeon check --json did not print JSON: ${(error as Error).message}`);
  }
  if (report.ok !== true || !Array.isArray(report.checks)) throw new SmokeError(`marmeon check did not pass: ${JSON.stringify(report)}`);
  for (const check of report.checks) {
    if (check.status !== 'passed' && check.status !== 'skipped') throw new SmokeError(`marmeon check: ${String(check.name)} is ${String(check.status)}, not passed.`);
    if (GUARDED.includes(String(check.name)) && (check.problems?.length ?? 0) > 0) {
      throw new SmokeError(`marmeon check: ${String(check.name)} found ${JSON.stringify(check.problems)} in the recipes' code.`);
    }
  }

  let docs: { sections?: { title?: unknown; pages?: { slug?: unknown }[] }[] };
  try {
    docs = JSON.parse(marmeon('docs', '--json'));
  } catch (error) {
    throw new SmokeError(`marmeon docs --json did not print JSON: ${(error as Error).message}`);
  }
  const listed = new Set(docs.sections?.find((section) => section.title === 'Recipes')?.pages?.map((page) => page.slug));
  for (const slug of slugs) if (!listed.has(slug)) throw new SmokeError(`marmeon docs --json lists no "${slug}" under "Recipes".`);
}
