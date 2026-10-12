import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { BUILT_IN } from './built-in.ts';
import { BUILT_IN_NAMES } from './built-in-names.ts';
import { MakeModuleCommand, MakeEventCommand, MakeListenerCommand, MakeMigrationCommand, MakeJobCommand, MakeNotificationCommand, MakeCommandCommand, MakeSeederCommand } from './commands/make.ts';

const MODULE = `import { defineModule } from '@marmeon/core';

export default defineModule({
  name: 'billing',
});
`;

function app(index = MODULE): { root: string; index: string } {
  const root = tempDir('marmeon-make-register-');
  mkdirSync(join(root, 'modules', 'billing'), { recursive: true });
  const file = join(root, 'modules', 'billing', 'index.ts');
  writeFileSync(file, index);
  return { root, index: file };
}

function run(command: { handle(input: any): number }, root: string, args: string[], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = command.handle({ root, args, options: { module: 'billing', ...options }, output });
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

const job = (root: string, options: Record<string, unknown> = {}) => run(new MakeJobCommand(), root, ['SendInvoiceReminder'], options);
const notification = (root: string, options: Record<string, unknown> = {}) => run(new MakeNotificationCommand(), root, ['InvoiceOverdue'], options);

describe('make:job and make:notification register themselves', () => {
  it('adds the job and its import to the module', () => {
    const { root, index } = app();
    const { code, lines } = job(root);
    expect(code).toBe(0);
    expect(lines).toContain('✓ Registered SendInvoiceReminderJob in modules/billing/index.ts (jobs)');
    const text = readFileSync(index, 'utf8');
    expect(text.match(/import \{ SendInvoiceReminderJob \} from '\.\/jobs\/SendInvoiceReminderJob\.ts';/g)).toHaveLength(1);
    expect(text).toContain('jobs: [SendInvoiceReminderJob]');
  });

  it('leaves the module byte for byte the same on a second run', () => {
    const { root, index } = app();
    job(root);
    const before = readFileSync(index, 'utf8');
    const { lines } = job(root, { force: true });
    expect(readFileSync(index, 'utf8')).toBe(before);
    expect(lines).toContain('SendInvoiceReminderJob is already registered in modules/billing/index.ts');
  });

  it('registers a job and a notification in one module, and appends to a list written out over lines', () => {
    const { root, index } = app(MODULE.replace("  name: 'billing',", "  name: 'billing',\n  jobs: [\n    Other,\n  ],"));
    writeFileSync(index, `import { Other } from './jobs/Other.ts';\n${readFileSync(index, 'utf8')}`);
    job(root);
    notification(root);
    const text = readFileSync(index, 'utf8');
    expect(text).toContain('  jobs: [\n    Other,\n    SendInvoiceReminderJob,\n  ],');
    expect(text).toContain('notifications: [InvoiceOverdueNotification]');
  });

  it('prints the lines and touches nothing with --no-register', () => {
    const { root, index } = app();
    const { code, lines } = notification(root, { 'no-register': true });
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
    expect(lines).toContain('Register it in modules/billing/index.ts:');
    expect(lines).toContain("  import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';");
    expect(lines).toContain('  notifications: [InvoiceOverdueNotification]');
  });

  it('falls back to the lines to add when the list is not written out in the module', () => {
    const source = MODULE.replace("  name: 'billing',", "  name: 'billing',\n  jobs: allJobs,");
    const { root, index } = app(source);
    const { code, lines } = job(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered — modules/billing/index.ts: ') && line.endsWith('Add it yourself:'))).toBe(true);
    expect(lines).toContain("  import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';");
    expect(lines).toContain('  jobs: [SendInvoiceReminderJob]');
  });

  it('names the module file, never an absolute path, when the module has no index.ts', () => {
    const { root, index } = app();
    rmSync(index);
    const { code, lines } = job(root);
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('! Not registered — modules/billing/index.ts: modules/billing/index.ts does not exist'))).toBe(true);
    expect(lines.filter((line) => line.includes(root))).toEqual([]);
  });
});

const listener = (root: string, name = 'SendReceipt', event = 'InvoicePaid', options: Record<string, unknown> = {}) =>
  run(new MakeListenerCommand(), root, [name], { event, ...options });
const migration = (root: string, options: Record<string, unknown> = {}) => run(new MakeMigrationCommand(), root, ['create_invoices_table'], options);

describe('make:listener registers the listener with its event', () => {
  it('follows the module\'s own event and joins the existing core import', () => {
    const { root, index } = app();
    run(new MakeEventCommand(), root, ['InvoicePaid']);
    const { code, lines } = listener(root);
    expect(code).toBe(0);
    expect(lines).toContain('✓ Registered SendReceipt in modules/billing/index.ts (listeners)');
    const text = readFileSync(index, 'utf8');
    expect(text).toContain("import { defineModule, listen } from '@marmeon/core';");
    expect(text).toContain("import { InvoicePaid } from './events/InvoicePaid.ts';");
    expect(text).toContain('listeners: [listen(InvoicePaid, SendReceipt)]');
    expect(readFileSync(join(root, 'modules', 'billing', 'listeners', 'SendReceipt.ts'), 'utf8')).toContain("import type { InvoicePaid } from '../events/InvoicePaid.ts';");
  });

  it('follows an event the module already imports from a package, without a second import', () => {
    const { root, index } = app(`import { Registered } from '@marmeon/auth';\n${MODULE}`);
    listener(root, 'Welcome', 'Registered');
    const text = readFileSync(index, 'utf8');
    expect(readFileSync(join(root, 'modules', 'billing', 'listeners', 'Welcome.ts'), 'utf8')).toContain("import type { Registered } from '@marmeon/auth';");
    expect(text.match(/import \{ Registered \}/g)).toHaveLength(1);
    expect(text).toContain('listeners: [listen(Registered, Welcome)]');
  });

  it('points a relative import of the module at the listener folder', () => {
    const { root } = app(`import { AccountDeleted } from '../auth/index.ts';\n${MODULE}`);
    listener(root, 'Farewell', 'AccountDeleted');
    expect(readFileSync(join(root, 'modules', 'billing', 'listeners', 'Farewell.ts'), 'utf8')).toContain("import type { AccountDeleted } from '../../auth/index.ts';");
  });

  it('does not register under a same-named binding that is not the module\'s own event', () => {
    const source = `import { InvoicePaid } from '@marmeon/auth';\n${MODULE}`;
    const { root, index } = app(source);
    run(new MakeEventCommand(), root, ['InvoicePaid']);
    const { code, lines } = listener(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered'))).toBe(true);
  });

  it('follows an aliased import of the event', () => {
    const { root, index } = app(`import { Registered as SignedUp } from '@marmeon/auth';\n${MODULE}`);
    listener(root, 'Welcome', 'SignedUp');
    const file = readFileSync(join(root, 'modules', 'billing', 'listeners', 'Welcome.ts'), 'utf8');
    expect(file).toContain("import type { Registered as SignedUp } from '@marmeon/auth';");
    expect(file).toContain('handle(event: SignedUp)');
    expect(readFileSync(index, 'utf8')).toContain('listeners: [listen(SignedUp, Welcome)]');
  });

  it('rewrites a sibling and a parent import for the listener folder', () => {
    const { root } = app(`import { Local } from './events.ts';\n${MODULE}`);
    listener(root, 'A', 'Local');
    expect(readFileSync(join(root, 'modules', 'billing', 'listeners', 'A.ts'), 'utf8')).toContain("from '../events.ts';");
  });

  it('reports a module that does not parse instead of a missing event', () => {
    const source = 'export default defineModule({ ;;';
    const { root, index } = app(source);
    const { lines } = listener(root);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.includes('does not parse') && !line.includes('neither'))).toBe(true);
  });

  it('writes the listener but leaves the module alone when the event is found nowhere', () => {
    const { root, index } = app();
    const { code, lines } = listener(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
    expect(lines.some((line) => line.startsWith('! Not registered — modules/billing/index.ts: InvoicePaid is neither in modules/billing/events/ nor imported'))).toBe(true);
    expect(lines).toContain('  listeners: [listen(InvoicePaid, SendReceipt)]');
  });

  it('is idempotent and keeps two listeners of one event', () => {
    const { root, index } = app();
    run(new MakeEventCommand(), root, ['InvoicePaid']);
    listener(root);
    const before = readFileSync(index, 'utf8');
    expect(listener(root, 'SendReceipt', 'InvoicePaid', { force: true }).lines).toContain('SendReceipt is already registered in modules/billing/index.ts');
    expect(readFileSync(index, 'utf8')).toBe(before);
    listener(root, 'Audit');
    expect(readFileSync(index, 'utf8')).toContain('listeners: [listen(InvoicePaid, SendReceipt), listen(InvoicePaid, Audit)]');
  });
});

describe('make:migration registers the migrations folder once', () => {
  it('adds the property on the first run and nothing on the second', () => {
    const { root, index } = app();
    const first = migration(root);
    expect(first.lines).toContain('✓ Registered the migrations folder in modules/billing/index.ts');
    const text = readFileSync(index, 'utf8');
    expect(text).toContain("migrations: new URL('./migrations/', import.meta.url)");
    const second = migration(root);
    expect(readFileSync(index, 'utf8')).toBe(text);
    expect(second.lines.some((line) => line.includes('already registered') || line.includes('Registered'))).toBe(false);
  });

  it('leaves a module with migrations written another way alone', () => {
    const source = MODULE.replace("  name: 'billing',", "  name: 'billing',\n  migrations: 'modules/billing/migrations',");
    const { root, index } = app(source);
    const { code, lines } = migration(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('!') || line.includes('Registered'))).toBe(false);
  });

  it('does not take the word in a comment or a name for the property', () => {
    const source = MODULE.replace("  name: 'billing',", "  name: 'billing', // migrations are added later\n  migrationsFolder: 'm',");
    const { root } = app(source);
    const printed = migration(root, { 'no-register': true });
    expect(printed.lines).toContain('Register the directory in the module (once):');
  });

  it('prints nothing for a definition built elsewhere that sets migrations', () => {
    const source = "import { defineModule } from '@marmeon/core';\n\nexport default defineModule(build({ migrations: new URL('./migrations/', import.meta.url) }));\n";
    const { root, index } = app(source);
    const { code, lines } = migration(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('!') || line.includes('Register'))).toBe(false);
  });

  it('prints the hint with --no-register only while migrations is missing', () => {
    const { root, index } = app();
    const missing = migration(root, { 'no-register': true });
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
    expect(missing.lines).toContain('Register the directory in the module (once):');
    const source = MODULE.replace("  name: 'billing',", "  name: 'billing',\n  migrations: 'm',");
    writeFileSync(index, source);
    const present = migration(root, { 'no-register': true, force: true });
    expect(present.lines.some((line) => line.includes('Register'))).toBe(false);
  });
});

const APP = `import { defineApplication } from '@marmeon/core';
import system from '#modules/system';

export default defineApplication({
  modules: [system],
});
`;

function bootstrapApp(source: string | null = APP): { root: string; file: string } {
  const root = tempDir('marmeon-make-register-');
  const file = join(root, 'bootstrap', 'app.ts');
  if (source !== null) {
    mkdirSync(join(root, 'bootstrap'), { recursive: true });
    writeFileSync(file, source);
  }
  return { root, file };
}

const makeModule = (root: string, name: string, options: Record<string, unknown> = {}) => run(new MakeModuleCommand(), root, [name], options);

describe('make:module registers the module in bootstrap/app.ts', () => {
  it('adds the import after the last one and the module at the end of the list', () => {
    const { root, file } = bootstrapApp();
    const { code, lines } = makeModule(root, 'billing');
    expect(code).toBe(0);
    expect(lines).toContain('✓ Registered the module in bootstrap/app.ts');
    expect(readFileSync(file, 'utf8')).toBe(
      APP.replace("import system from '#modules/system';", "import system from '#modules/system';\nimport billing from '#modules/billing';").replace(
        '[system]',
        '[system, billing]',
      ),
    );
    makeModule(root, 'shop-cart');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain("import shopCart from '#modules/shop-cart';");
    expect(text).toContain('modules: [system, billing, shopCart]');
  });

  it('imports a module named like a reserved word under a valid name', () => {
    const { root, file } = bootstrapApp();
    makeModule(root, 'let');
    makeModule(root, 'class');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain("import letModule from '#modules/let';");
    expect(text).toContain("import classModule from '#modules/class';");
    expect(text).toContain('modules: [system, letModule, classModule]');
  });

  it('leaves the file byte for byte the same when the module is registered', () => {
    const { root, file } = bootstrapApp();
    makeModule(root, 'billing');
    const before = readFileSync(file, 'utf8');
    const { lines } = makeModule(root, 'billing', { force: true });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(lines).toContain('billing is already registered in bootstrap/app.ts');
  });

  it('prints the lines and touches nothing with --no-register', () => {
    const { root, file } = bootstrapApp();
    const { lines } = makeModule(root, 'billing', { 'no-register': true });
    expect(readFileSync(file, 'utf8')).toBe(APP);
    expect(lines).toContain('Register it in bootstrap/app.ts:');
  });

  it('falls back to the lines when the list is not written out', () => {
    const source = APP.replace('[system]', 'allModules');
    const { root, file } = bootstrapApp(source);
    const { code, lines } = makeModule(root, 'billing');
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered — bootstrap/app.ts:'))).toBe(true);
    expect(lines).toContain("  modules: [..., billing]");
  });

  it('does not register under a name that is already bound to something else', () => {
    const source = APP.replace("import system", "import billing from '#modules/other';\nimport system");
    const { root, file } = bootstrapApp(source);
    const { lines } = makeModule(root, 'billing');
    expect(readFileSync(file, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered'))).toBe(true);
  });

  it('prints the lines without a warning when the app has no bootstrap/app.ts', () => {
    const { root } = bootstrapApp(null);
    const { code, lines } = makeModule(root, 'billing');
    expect(code).toBe(0);
    expect(lines).toContain('Register it in bootstrap/app.ts:');
    expect(lines.some((line) => line.startsWith('!'))).toBe(false);
  });
});

describe('make:command and make:seeder register themselves', () => {
  const command = (root: string, args = ['PruneInvoices'], options: Record<string, unknown> = {}) => run(new MakeCommandCommand(), root, args, options);
  const seeder = (root: string, args = ['Invoice'], options: Record<string, unknown> = {}) => run(new MakeSeederCommand(), root, args, options);

  it('writes a command named after its module and class, and lists it', () => {
    const { root, index } = app();
    const { code, lines } = command(root);
    expect(code).toBe(0);
    expect(lines).toContain('✓ Registered PruneInvoicesCommand in modules/billing/index.ts (commands)');
    const text = readFileSync(index, 'utf8');
    expect(text).toContain("import { PruneInvoicesCommand } from './commands/PruneInvoicesCommand.ts';");
    expect(text).toContain('commands: [PruneInvoicesCommand]');
    const file = readFileSync(join(root, 'modules/billing/commands/PruneInvoicesCommand.ts'), 'utf8');
    expect(file).toContain("static command = 'billing:prune-invoices';");
    expect(file).toContain("import type { CommandInput } from 'marmeon';");
  });

  it('writes a seeder, lists it last and says the order is the list', () => {
    const { root, index } = app(MODULE.replace("  name: 'billing',", "  name: 'billing',\n  seeders: [Other],"));
    const { code, lines } = seeder(root);
    expect(code).toBe(0);
    expect(lines).toContain('✓ Registered InvoiceSeeder in modules/billing/index.ts (seeders)');
    expect(lines.some((line) => line.includes('order of `seeders`') && line.includes('added last'))).toBe(true);
    expect(readFileSync(index, 'utf8')).toContain('seeders: [Other, InvoiceSeeder]');
    expect(readFileSync(join(root, 'modules/billing/seeders/InvoiceSeeder.ts'), 'utf8')).toContain('async handle({ db, factory }: SeedContext)');
  });

  it('is idempotent with --force', () => {
    const { root, index } = app();
    command(root);
    seeder(root);
    const before = readFileSync(index, 'utf8');
    expect(command(root, ['PruneInvoices'], { force: true }).lines).toContain('PruneInvoicesCommand is already registered in modules/billing/index.ts');
    const again = seeder(root, ['Invoice'], { force: true }).lines;
    expect(again).toContain('InvoiceSeeder is already registered in modules/billing/index.ts');
    expect(again.some((line) => line.includes('added last'))).toBe(false);
    expect(readFileSync(index, 'utf8')).toBe(before);
  });

  it('prints the lines and touches nothing with --no-register', () => {
    const { root, index } = app();
    const { lines } = command(root, ['PruneInvoices'], { 'no-register': true });
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
    expect(lines).toContain('  commands: [PruneInvoicesCommand]');
    const printed = seeder(root, ['Invoice'], { 'no-register': true }).lines;
    expect(printed).toContain('  seeders: [InvoiceSeeder]');
    expect(printed.some((line) => line.includes('added last'))).toBe(false);
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
  });

  it('falls back to the lines when the list is not written out', () => {
    const source = MODULE.replace("  name: 'billing',", "  name: 'billing',\n  seeders: allSeeders,");
    const { root, index } = app(source);
    const { code, lines } = seeder(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered — modules/billing/index.ts: '))).toBe(true);
    expect(lines.some((line) => line.includes('added last'))).toBe(false);
  });

  it('refuses a name that is a built-in command and writes nothing', () => {
    const { root } = app();
    mkdirSync(join(root, 'modules', 'make'), { recursive: true });
    writeFileSync(join(root, 'modules', 'make', 'index.ts'), MODULE.replace('billing', 'make'));
    const { code, lines } = run(new MakeCommandCommand(), root, ['Seeder'], { module: 'make' });
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith('✗ make:seeder is already a built-in command'))).toBe(true);
    expect(existsSync(join(root, 'modules', 'make', 'commands'))).toBe(false);
    expect(readFileSync(join(root, 'modules', 'make', 'index.ts'), 'utf8')).toBe(MODULE.replace('billing', 'make'));
    expect(command(root, ['PruneInvoices']).lines.some((line) => line.startsWith('!') || line.startsWith('✗'))).toBe(false);
  });

  it('refuses a name another module of the app already uses and writes nothing', () => {
    const { root, index } = app();
    mkdirSync(join(root, 'modules', 'other', 'commands'), { recursive: true });
    writeFileSync(join(root, 'modules', 'other', 'commands', 'Prune.ts'), "export class Prune {\n  static command = 'billing:prune-invoices';\n}\n");
    const { code, lines } = command(root);
    expect(code).toBe(1);
    expect(lines.some((line) => line.includes('billing:prune-invoices') && line.includes('modules/other/commands/Prune.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules', 'billing', 'commands'))).toBe(false);
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
  });

  it('keeps the list of built-in names in step with the registered commands', () => {
    expect([...BUILT_IN_NAMES].filter((name) => name !== 'list' && name !== 'help').sort()).toEqual(BUILT_IN.map((c) => c.command).sort());
  });

  it('refuses a name that is not PascalCase and writes nothing', () => {
    const { root } = app();
    expect(command(root, ['prune-invoices']).code).toBe(1);
    expect(seeder(root, ['invoice']).code).toBe(1);
    expect(() => readFileSync(join(root, 'modules/billing/seeders/invoiceSeeder.ts'))).toThrow();
  });
});
