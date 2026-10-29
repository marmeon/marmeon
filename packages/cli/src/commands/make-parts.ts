import { join } from 'node:path';
import { CommandArgumentsError, type CommandInput } from '../command.ts';
import { style } from '../output.ts';
import { className, dependsOn, moduleDir, moduleOption, SNAKE, write } from './make.ts';
import { pluralOf, tableDeclared, wordsOf } from './make-resource.ts';

// These three add one file to a module that exists. None registers it: a factory is imported where a test or seeder uses it, a
// table is registered by `tableRoutes()` in the page's routes, and a repository is built by the container from its class.

const partOptions = { ...moduleOption, table: { type: 'string' } } as const;

/** The table of a record called `name` (`InvoiceLine` → `invoice_lines`), or the one `--table` names. */
function tableOf(input: CommandInput, name: string, suffix: string): string {
  const requested = input.options.table;
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !SNAKE.test(requested)) {
      throw new CommandArgumentsError('Pass the table as --table=<snake_case_name>, e.g. --table=invoice_lines');
    }
    return requested;
  }
  const record = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  // A name that is already a plural (Members) stays; Status, Address and Bus end in s but are singular.
  return wordsOf(/[^siu]s$/.test(record) ? record : pluralOf(record)).join('_');
}

/** Refuses, naming the package to add, when the app lacks one the generated file imports. */
/** The class name, refused when it is only the suffix: `Table` would shadow the `defineTable` it is made with. */
function partName(input: CommandInput, suffix: string): string | undefined {
  if (input.args[0] === suffix) throw new CommandArgumentsError(`Pass the name of the record before ${suffix}, e.g. Invoice${suffix}.`);
  return className(input, suffix);
}

function needs(input: CommandInput, packages: readonly (readonly [name: string, why: string])[]): boolean {
  for (const [name, why] of packages) {
    if (!dependsOn(input.root, name)) {
      input.output.error(`${why} ${name}: pnpm add -E ${name}@<version of your app>`);
      return false;
    }
  }
  return true;
}

/** Says, when the app's generated table types lack the table, what makes the generated file compile. */
function tableHint(input: CommandInput, table: string): void {
  if (tableDeclared(input.root, table)) return;
  input.output.line(style('dim', `bootstrap/database.d.ts does not declare "${table}" yet: create its migration (marmeon make:migration), then marmeon migrate. Another table: --table=<name>.`));
}

export class MakeRepositoryCommand {
  static command = 'make:repository';
  static description = 'Create a repository of one table (the plural of the name, or --table)';
  static usage = '<Name> --module=<module> [--table=<table>]';
  static options = partOptions;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = partName(input, 'Repository');
    if (!dir || !name) return 1;
    if (!needs(input, [['@marmeon/database', 'A repository reads and writes through']])) return 1;
    const table = tableOf(input, name, 'Repository');
    if (!write(input, join(dir, `${name}.ts`), REPOSITORY(name, table))) return 1;
    tableHint(input, table);
    input.output.line(style('dim', `Register it once in the module's provider: container.singleton(${name});`));
    input.output.line(style('dim', 'See docs/queries.md#defining-a-repository'));
    return 0;
  }
}

export class MakeFactoryCommand {
  static command = 'make:factory';
  static description = 'Create a factory of one table (the plural of the name, or --table)';
  static usage = '<Name> --module=<module> [--table=<table>]';
  static options = partOptions;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = partName(input, 'Factory');
    if (!dir || !name) return 1;
    if (!needs(input, [['@marmeon/database', 'A factory is defined with']])) return 1;
    const table = tableOf(input, name, 'Factory');
    if (!write(input, join(dir, 'factories', `${name}.ts`), FACTORY(name, table))) return 1;
    tableHint(input, table);
    input.output.line(style('dim', `Use it: factory(${name}).create() in a test or seeder.`));
    input.output.line(style('dim', 'See docs/seeding.md#defining-factories'));
    return 0;
  }
}

export class MakeTableCommand {
  static command = 'make:table';
  static description = 'Create a data table of one table (the plural of the name, or --table) that nobody may see until you decide';
  static usage = '<Name> --module=<module> [--table=<table>]';
  static options = partOptions;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = partName(input, 'Table');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    if (
      !needs(input, [
        ['@marmeon/table', 'A data table is defined with'],
        ['@marmeon/auth', 'The table asks who the signed-in user is with'],
        ['@marmeon/database', 'The table reads through'],
      ])
    ) {
      return 1;
    }
    const table = tableOf(input, name, 'Table');
    if (!write(input, join(dir, 'tables', `${name}.ts`), TABLE(name, table, module))) return 1;
    tableHint(input, table);
    input.output.line(style('dim', `Decide who may see it: replace \`authorize: () => false\` with can(Policy, 'viewAny'). The columns of ${table} go in \`columns\`.`));
    input.output.line(style('dim', `Show it: tableRoutes(<the page's registrar>, ${name}); in the module's routes.ts, with a controller that resolves it (DataTables).`));
    input.output.line(style('dim', 'See docs/tables.md#the-controller-and-the-routes'));
    return 0;
  }
}

const REPOSITORY = (name: string, table: string) => `import { Repository } from '@marmeon/database';

export class ${name} extends Repository<'${table}'> {
  static table = '${table}' as const;
}
`;

const FACTORY = (name: string, table: string) => `import { defineFactory } from '@marmeon/database';

export const ${name} = defineFactory('${table}', () => ({
  // A value for each column that is NOT NULL and has no default; the compiler lists the ones missing.
  // Unique values come from the context's sequence: ({ sequence }) => ({ slug: \`…-\${sequence}\` }). A date comes from its
  // now(), the app's time: published_at: now().toISOString() — never new Date().
}));
`;

const TABLE = (name: string, table: string, module: string) => `import type { Authenticated } from '@marmeon/auth';
import type { Database } from '@marmeon/database';
import { column, defineTable, type TableContext } from '@marmeon/table';

export const ${name} = defineTable({
  name: '${table}',
  // Every row the table may ever show; put the tenant here. Pages, actions and exports all start from it.
  query: (db: Database<'${module}'>, _ctx: TableContext<Authenticated>) => db.selectFrom('${table}'),
  key: '${table}.id',
  columns: {
    id: column('${table}.id').label('ID').sortable(),
  },
  // Nobody sees the table until you say who may: \`can(Policy, 'viewAny')\`.
  authorize: () => false,
});
`;
