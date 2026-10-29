import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import { CommandArgumentsError, type CommandClass, type CommandInput } from './command.ts';
import { MakeFactoryCommand, MakeRepositoryCommand, MakeTableCommand } from './commands/make-parts.ts';

const ALL = JSON.stringify({ dependencies: { '@marmeon/database': 'workspace:*', '@marmeon/table': 'workspace:*', '@marmeon/auth': 'workspace:*' } });

function app(manifest: string | null = ALL): string {
  const root = tempDir('marmeon-make-parts-');
  mkdirSync(join(root, 'modules', 'billing'), { recursive: true });
  if (manifest !== null) writeFileSync(join(root, 'package.json'), manifest);
  return root;
}

function run(Command: CommandClass, root: string, args: string[], options: Record<string, unknown> = { module: 'billing' }) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  let code: number;
  try {
    code = new (Command as new () => { handle(input: CommandInput): number })().handle({ root, args, options, output } as unknown as CommandInput);
  } catch (error) {
    if (!(error instanceof CommandArgumentsError)) throw error;
    output.error(error.message);
    code = 2;
  }
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

const generators = [
  [MakeRepositoryCommand, 'make:repository', 'Invoice', 'modules/billing/InvoiceRepository.ts'],
  [MakeFactoryCommand, 'make:factory', 'Invoice', 'modules/billing/factories/InvoiceFactory.ts'],
  [MakeTableCommand, 'make:table', 'Invoice', 'modules/billing/tables/InvoiceTable.ts'],
] as const;

describe.each(generators)('%s', (Command, name, record, file) => {
  it('is a built-in command that does not boot the app', () => {
    expect(BUILT_IN).toContain(Command);
    expect(Command.command).toBe(name);
    expect(Command.boots).toBe(false);
  });

  it('writes its file into the module and registers nothing', () => {
    const root = app();
    const index = "export default {};\n";
    writeFileSync(join(root, 'modules/billing/index.ts'), index);
    const { code, lines } = run(Command, root, [record]);
    expect(code).toBe(0);
    expect(lines).toContain(`✓ Created ${file}`);
    expect(readFileSync(join(root, 'modules/billing/index.ts'), 'utf8')).toBe(index);
  });

  it('never overwrites, unless --force', () => {
    const root = app();
    run(Command, root, [record]);
    writeFileSync(join(root, file), '// mine\n');
    const second = run(Command, root, [record]);
    expect([second.code, second.lines]).toEqual([1, [`✗ ${file} already exists (use --force to overwrite).`]]);
    expect(readFileSync(join(root, file), 'utf8')).toBe('// mine\n');
    expect(run(Command, root, [record], { module: 'billing', force: true }).code).toBe(0);
    expect(readFileSync(join(root, file), 'utf8')).not.toBe('// mine\n');
  });

  it('writes nothing and names the package the app lacks', () => {
    for (const manifest of [JSON.stringify({ dependencies: {} }), null]) {
      const root = app(manifest);
      const { code, lines } = run(Command, root, [record]);
      expect(code).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^✗ .* @marmeon\/[a-z]+: pnpm add -E @marmeon\/[a-z]+@<version of your app>$/);
      expect(existsSync(join(root, file))).toBe(false);
    }
  });

  it('refuses a name that is no PascalCase, a table that is no snake_case and a module that is not there', () => {
    const root = app();
    expect(run(Command, root, ['invoice']).code).toBe(2);
    expect(run(Command, root, ['../Invoice']).code).toBe(2);
    expect(run(Command, root, [record], { module: 'billing', table: '../x' }).code).toBe(2);
    expect(run(Command, root, [record], { module: 'billing', table: 'Invoices' }).code).toBe(2);
    expect(run(Command, root, [record], { module: 'missing' }).lines[0]).toContain('Module "missing" does not exist');
    expect(run(Command, root, [record], { module: '../billing' }).code).toBe(2);
    expect(existsSync(join(root, file))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes nothing outside the project through a linked folder of the module', () => {
    const root = app();
    const outside = tempDir('marmeon-make-parts-outside-');
    symlinkSync(outside, join(root, 'modules', 'linked'), 'dir');
    const { code } = run(Command, root, [record], { module: 'linked' });
    expect(code).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('make:repository', () => {
  it('names the plural snake table of the name, and --table another', () => {
    const root = app();
    expect(run(MakeRepositoryCommand, root, ['InvoiceLine']).code).toBe(0);
    const repository = readFileSync(join(root, 'modules/billing/InvoiceLineRepository.ts'), 'utf8');
    expect(repository).toContain("export class InvoiceLineRepository extends Repository<'invoice_lines'> {");
    expect(repository).toContain("static table = 'invoice_lines' as const;");
    run(MakeRepositoryCommand, root, ['Bill'], { module: 'billing', table: 'invoices' });
    expect(readFileSync(join(root, 'modules/billing/BillRepository.ts'), 'utf8')).toContain("Repository<'invoices'>");
    // A name that ends in the suffix is not suffixed twice, nor pluralized with it.
    expect(run(MakeRepositoryCommand, root, ['CategoryRepository']).code).toBe(0);
    expect(readFileSync(join(root, 'modules/billing/CategoryRepository.ts'), 'utf8')).toContain("Repository<'categories'>");
  });

  it('says what is missing when the table is not in the generated types', () => {
    const root = app();
    expect(run(MakeRepositoryCommand, root, ['Invoice']).lines.join('\n')).toContain('bootstrap/database.d.ts does not declare "invoices" yet');
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(join(root, 'bootstrap/database.d.ts'), 'interface Tables {\n    invoices: {\n      id: number;\n    };\n  }\n');
    const declared = run(MakeRepositoryCommand, root, ['Invoice'], { module: 'billing', force: true });
    expect(declared.lines.join('\n')).not.toContain('does not declare');
  });
});

describe('the default table', () => {
  it('keeps a plural, and pluralizes a singular that ends in s', () => {
    const root = app();
    for (const [name, table] of [['Members', 'members'], ['Status', 'statuses'], ['Member', 'members'], ['Address', 'addresses']] as const) {
      expect(run(MakeRepositoryCommand, root, [name]).code).toBe(0);
      expect(readFileSync(join(root, `modules/billing/${name}Repository.ts`), 'utf8')).toContain(`Repository<'${table}'>`);
    }
  });

  it('refuses a name that is only the suffix', () => {
    const root = app();
    for (const [Command, suffix] of [[MakeRepositoryCommand, 'Repository'], [MakeFactoryCommand, 'Factory'], [MakeTableCommand, 'Table']] as const) {
      expect(run(Command, root, [suffix]).code).toBe(2);
    }
    expect(existsSync(join(root, 'modules/billing/factories'))).toBe(false);
  });
});

describe('make:factory', () => {
  it('defines the factory of the table and points to now() for a date', () => {
    const root = app();
    expect(run(MakeFactoryCommand, root, ['Invoice']).code).toBe(0);
    const factory = readFileSync(join(root, 'modules/billing/factories/InvoiceFactory.ts'), 'utf8');
    expect(factory).toContain("export const InvoiceFactory = defineFactory('invoices', () => ({");
    expect(factory).toContain('now()');
    expect(factory).toContain('never new Date()');
    expect(factory).not.toMatch(/(?<!never )new Date\(\)/);
  });
});

describe('make:table', () => {
  it('writes a table with one column that nobody may see yet', () => {
    const root = app();
    const { code, lines } = run(MakeTableCommand, root, ['Invoice']);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('tableRoutes(');
    const table = readFileSync(join(root, 'modules/billing/tables/InvoiceTable.ts'), 'utf8');
    expect(table).toContain("export const InvoiceTable = defineTable({");
    expect(table).toContain("name: 'invoices',");
    expect(table).toContain("query: (db: Database<'billing'>, _ctx: TableContext<Authenticated>) => db.selectFrom('invoices'),");
    expect(table).toContain("key: 'invoices.id',");
    expect(table).toContain("id: column('invoices.id').label('ID').sortable(),");
    expect(table).toContain('authorize: () => false,');
    expect(table).not.toContain('exportCsv');
  });

  it('needs the table, auth and database packages, one by one', () => {
    for (const missing of ['@marmeon/table', '@marmeon/auth', '@marmeon/database']) {
      const dependencies = Object.fromEntries(['@marmeon/table', '@marmeon/auth', '@marmeon/database'].filter((name) => name !== missing).map((name) => [name, '*']));
      const root = app(JSON.stringify({ dependencies }));
      const { code, lines } = run(MakeTableCommand, root, ['Invoice']);
      expect([code, lines[0]]).toEqual([1, expect.stringContaining(`${missing}: pnpm add -E ${missing}@<version of your app>`)]);
    }
  });
});
