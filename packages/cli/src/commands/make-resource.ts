import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CommandArgumentsError, type CommandInput } from '../command.ts';
import { style } from '../output.ts';
import { leavesProject } from '../write-guard.ts';
import { dependsOn, KEBAB, migrationStamp, PASCAL, registerModule } from './make.ts';
import { resourceFiles, type ResourceNames } from './make-resource-templates.ts';

/**
 * Names the generated files use for local variables or that the language reserves: a record called `Title` or `Class` would
 * not compile, so the generator refuses it before it writes anything.
 */
const RESERVED = new Set([
  ...'abstract await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(' '),
  ...'app ada bob asAda fields form id mine page props title user users ctx everyone authenticate verified expect describe it beforeEach application can r defineRoutes defineMigration defineRequest'.split(' '),
]);

/** `BlogPost` → `['blog', 'post']`, `HTMLPage` → `['html', 'page']`. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(' ');

const upperFirst = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const camel = (words: readonly string[]) => words[0]! + words.slice(1).map(upperFirst).join('');

/** The plural of an English noun in the three ways code names need: `Category` → `Categories`, `Box` → `Boxes`, `Bookmark` → `Bookmarks`. */
function pluralOf(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}

/** Where the starter kit's layout is: in the auth module (`make:auth`), or — in an app that moved it — in `layouts/`. As a view imports it. */
function layoutImport(root: string): string | undefined {
  if (existsSync(join(root, 'modules/auth/layouts/AppLayout.tsx'))) return '../../auth/layouts/AppLayout.tsx';
  if (existsSync(join(root, 'layouts/AppLayout.tsx'))) return '../../../layouts/AppLayout.tsx';
  return undefined;
}

/** Whether the app's `Tables` (bootstrap/database.d.ts, read as text — nothing boots) already declares this table. */
function tableDeclared(root: string, table: string): boolean {
  const file = join(root, 'bootstrap/database.d.ts');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const start = text.search(/interface Tables\s*\{/);
  if (start < 0) return false;
  const rest = text.slice(start);
  const end = rest.search(/\n {2}\}/);
  const body = end > 0 ? rest.slice(0, end) : rest;
  return new RegExp(`^\\s+${table}:\\s*\\{`, 'm').test(body);
}

export class MakeResourceCommand {
  static command = 'make:resource';
  static description = 'Create a module for a record of the signed-in user: table, policy, requests, controllers, pages and test';
  static usage = '<Name> [--module=<module>] [--no-register]';
  static options = { module: { type: 'string', short: 'm' }, 'no-register': { type: 'boolean' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const [name] = input.args;
    if (!name || !PASCAL.test(name)) {
      throw new CommandArgumentsError('Pass a PascalCase singular name, e.g. marmeon make:resource Bookmark');
    }
    const words = wordsOf(name);
    const plural = pluralOf(name);
    const pluralWords = wordsOf(plural);
    const requested = input.options.module;
    if (requested !== undefined && (typeof requested !== 'string' || !KEBAB.test(requested))) {
      throw new CommandArgumentsError('Pass the module as --module=<kebab-case-name>');
    }
    const module = requested ?? pluralWords.join('-');
    if (!KEBAB.test(module)) {
      throw new CommandArgumentsError(`${name} gives no module name (${module}); pass one: --module=<kebab-case-name>`);
    }
    const param = camel(words);
    const list = camel(pluralWords);
    if (RESERVED.has(param) || RESERVED.has(list)) {
      throw new CommandArgumentsError(`${name} is a word the generated code uses itself (${param}): name the record more precisely, e.g. a Task of a project as ProjectTask.`);
    }

    // Every precondition before the first byte is written.
    const dir = join(input.root, 'modules', module);
    if (existsSync(dir)) {
      input.output.error(`modules/${module} already exists: make:resource writes a new module and changes nothing in an existing one.`);
      return 1;
    }
    const table = module.replaceAll('-', '_');
    if (tableDeclared(input.root, table)) {
      input.output.error(`The table ${table} already exists in bootstrap/database.d.ts: pass another module, --module=<kebab-case-name>.`);
      return 1;
    }
    const layout = layoutImport(input.root);
    if (!dependsOn(input.root, '@marmeon/auth') || !existsSync(join(input.root, 'modules/auth/index.ts')) || layout === undefined) {
      input.output.error(
        "make:resource writes records that belong to a signed-in user, in the starter kit's layout: it needs the auth module (marmeon make:auth)",
      );
      return 1;
    }

    const names: ResourceNames = {
      name,
      plural,
      module,
      table,
      param,
      list,
      words: words.join(' '),
      pluralWords: pluralWords.join(' '),
      layout,
    };
    const files = resourceFiles(names, migrationStamp(join(dir, 'migrations')));
    if (leavesProject(input, [...files.keys()].map((path) => join(dir, path)).concat(join(input.root, 'bootstrap/app.ts')))) return 1;
    for (const [path, contents] of files) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      input.output.success(`Created ${relative(input.root, file)}`);
    }

    registerModule(input, module, dir);
    input.output.line();
    input.output.line('Next:');
    input.output.line(style('dim', '  marmeon migrate'));
    input.output.line(style('dim', '  marmeon db:types'));
    input.output.line(style('dim', '  marmeon route:types'));
    input.output.line(style('dim', `  pnpm test modules/${module}`));
    input.output.line(style('dim', 'See docs/starter-kit.md#adding-a-resource'));
    return 0;
  }
}
