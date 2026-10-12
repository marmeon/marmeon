import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConditions, writeInjectionArtifacts, writeManifest } from '@marmeon/core';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// Slow under load: more time on CI runners only (CI=true).
const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(repo, 'packages/cli/bin/marmeon.js');
const webApp = join(repo, 'apps/web-app');
const tsc = join(repo, 'node_modules/.bin/tsc');

function marmeon(cwd: string, args: string[], env: Record<string, string> = {}) {
  // The launcher must re-exec, not think it is the child; and the web app here is the SQLite app of
  // .env.test — `pnpm test:pgsql` points app tests at Postgres, commands get that only when a test says so.
  const { MARMEON_CHILD: _child, DB_CONNECTION: _connection, DB_URL: _url, ...parent } = process.env;
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...parent, NO_COLOR: '1', ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('marmeon (in the web app)', () => {
  it('lists commands grouped by namespace', () => {
    const { code, stdout } = marmeon(webApp, []);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^ {2}dev\s+Start the development server/m);
    expect(stdout).toMatch(/^make\n(?: {2}make:.*\n)+/m);
    expect(stdout).toContain('route:list');
    expect(stdout).toContain('db:show');
    expect(stdout).not.toMatch(/^ {2}serve\b/m); // internal
  });

  it('lists routes through a command that gets the Router injected', () => {
    const { code, stdout } = marmeon(webApp, ['route:list']);
    expect(code).toBe(0);
    // Execution order: global first, then the web group (cookies before the session), the route's own last.
    expect(stdout).toMatch(
      /GET\s+\/users\/:user\s+user-profile\.show\s+web\s+SecurityHeaders, ContentSecurityPolicy, LimitLiveValidation, EncryptCookies, ClearClientHistory, StartSession, NoStoreWhenSignedIn, .*ShareAppProps, authenticate, verified\s+ShowUserProfileController/,
    );
    expect(stdout).toMatch(/GET\s+\/api\/users\s+api\.users\.index\s+api\s+SecurityHeaders, ContentSecurityPolicy, LimitLiveValidation, authenticate:api, abilities:users:read\s+ListUsersController/);
    expect(stdout).toMatch(/\n\d+ routes\n$/); // the count grows with the app
  });

  it('prints configuration errors without Node internals and exits with 1', () => {
    const { code, stderr } = marmeon(webApp, ['route:list'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ Invalid configuration — the application cannot start:\n {2}• app: APP_NAME/);
    expect(stderr).not.toMatch(/triggerUncaughtException|node:internal/);
  });

  it('says how to fix an error the app cannot start with — the solutions as text', () => {
    const { code, stdout } = marmeon(webApp, ['route:list'], { APP_KEY: '' });
    expect(code).toBe(1);
    // The installed package's solution (encryption) first, then the core's.
    expect(stdout).toContain('How to fix it: Generate an application key');
    expect(stdout).toContain('  $ marmeon key:generate');
    expect(stdout).toContain('How to fix it: Set APP_KEY in .env');
  });

  it('shows the database connection (db:show, added by @marmeon/database)', () => {
    const { code, stdout } = marmeon(webApp, ['db:show'], { DB_DATABASE: ':memory:' });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Connection {2}default\nTarget {6}sqlite :memory:\nServer {6}SQLite 3\.\d+/m);
    expect(stdout).toContain('No tables yet.');
  });

  it('runs the modules’ migrations in timestamp order (migrate, migrate:status)', () => {
    const memory = { DB_DATABASE: ':memory:' }; // every process starts empty
    const status = marmeon(webApp, ['migrate:status'], memory);
    expect(status.stdout).toMatch(
      /2026_10_01_120000_create_users_table\s+auth\s+Pending\n2026_10_01_120100_create_login_activity_table\s+user-profile\s+Pending\n2026_10_01_120101_create_profile_links_table\s+user-profile\s+Pending/,
    );
    const migrate = marmeon(webApp, ['migrate'], memory);
    expect(migrate.code).toBe(0);
    // Every module's migrations, in timestamp order (the list grows with the app) …
    const ran = [...migrate.stdout.matchAll(/^✓ Migrated (\d{4}_\d\d_\d\d_\d{6}_\w+) \(([\w-]+)\) [\d.]+ ms$/gm)].map((match) => match[1]!);
    expect(ran.slice(0, 3)).toEqual(['2026_10_01_120000_create_users_table', '2026_10_01_120100_create_login_activity_table', '2026_10_01_120101_create_profile_links_table']);
    expect(ran).toEqual(ran.toSorted());
    // It names the environment it assumed — and a test writes no table types (development only).
    expect(migrate.stdout).toMatch(/^Environment: test \(APP_ENV=testing\)\n/);
    expect(migrate.stdout).not.toContain('database.d.ts');
  });

  it('asks for --force wherever the app is protected — APP_ENV=local on production too — and writes table types in development only', () => {
    const memory = { DB_DATABASE: ':memory:' };
    // Outside NODE_ENV=test the app reads .env, which CI does not have: what it needs to boot comes from here.
    const key = /^APP_KEY=(.*)$/m.exec(readFileSync(join(webApp, '.env.test'), 'utf8'))![1]!;
    const config = { ...memory, SYSTEM_DB_DATABASE: ':memory:', APP_NAME: 'Marmeon', APP_URL: 'http://localhost', APP_KEY: key, DEVTOOLS_ENABLED: 'false' };
    // Development regenerates the table types (already committed, so unchanged).
    const development = marmeon(webApp, ['migrate'], { ...config, NODE_ENV: 'development' });
    expect(development.stdout).toMatch(/ℹ bootstrap\/database\.d\.ts is up to date\.\n$/);
    expect(marmeon(webApp, ['migrate:fresh'], { ...config, NODE_ENV: 'production' }).stderr).toContain('The application is protected (production (APP_ENV=production)). Pass --force to drop every table — or, on a development machine, set NODE_ENV=development (in .env or the environment).');
    // APP_ENV names the environment and protects or opens nothing: APP_ENV=local on production asks for --force; with it,
    // it migrates — and writes no types (development only).
    const local = marmeon(webApp, ['migrate'], { ...config, NODE_ENV: 'production', APP_ENV: 'local' });
    expect(local.code, 'APP_ENV=local on production migrated without --force').toBe(1);
    expect(local.stdout).toContain('Environment: production (APP_ENV=local)\n');
    expect(local.stdout).not.toContain('Migrated');
    expect(local.stderr).toContain('Pass --force to migrate — or, on a development machine, set NODE_ENV=development (in .env or the environment).');
    // Any other NODE_ENV stops before the app loads — with the way to name a staging server.
    const staging = marmeon(webApp, ['migrate', '--force'], { ...config, NODE_ENV: 'staging' });
    expect(staging.code).toBe(1);
    expect(staging.stdout).toBe('');
    expect(staging.stderr).toBe(
      '✗ Invalid environment — the application cannot start:\n  • NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging. ' +
        'NODE_ENV is development, test or production; APP_ENV names the environment (docs/configuration.md#the-environment-node_env).\n',
    );
    const forced = marmeon(webApp, ['migrate', '--force'], { ...config, NODE_ENV: 'production', APP_ENV: 'staging' });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('Migrated 2026_10_01_120000_create_users_table');
    expect(forced.stdout).not.toContain('database.d.ts');
  }, 30_000);

  it('migrates from scratch and seeds (migrate:fresh --seed, db:seed)', () => {
    const fresh = marmeon(webApp, ['migrate:fresh', '--seed', '--no-types'], { DB_DATABASE: ':memory:' });
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toMatch(/✓ Seeded DemoUsersSeeder \(auth\) [\d.]+ ms\n✓ Seeded DemoLinksSeeder \(user-profile\) [\d.]+ ms\n$/);
    const unknown = marmeon(webApp, ['db:seed', '--class=Nope'], { DB_DATABASE: ':memory:' });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe('✗ There is no seeder "Nope".\n');
  }, 30_000);

  it('checks that the committed table types match the migrations (db:types --check, as in CI)', () => {
    const { code, stdout } = marmeon(webApp, ['db:types', '--check'], { DB_DATABASE: ':memory:' });
    expect(stdout).toContain('✓ bootstrap/database.d.ts matches the migrations.');
    expect(code).toBe(0);
  });

  it('checks that the committed route types match the routes and views (route:types --check, as in CI)', () => {
    const { code, stdout } = marmeon(webApp, ['route:types', '--check']);
    expect(stdout).toContain('✓ bootstrap/routes.ts matches the routes and views.');
    expect(code).toBe(0);
  });

  it('writes the route types without a secret — route:types registers the app and boots nothing, as marmeon build runs it', () => {
    // What a Docker build has: no .env of the app's (CI has none anyway), no key, no name — here emptied over whatever .env holds.
    const withoutSecrets = { NODE_ENV: 'production', APP_KEY: '', APP_PREVIOUS_KEYS: '', APP_NAME: '', APP_URL: '' };
    const types = marmeon(webApp, ['route:types', '--check'], withoutSecrets);
    expect(types.stderr).not.toContain('Invalid configuration');
    expect(types.stdout).toContain('✓ bootstrap/routes.ts matches the routes and views.');
    expect(types.code).toBe(0);
    // A command that runs the app still needs them.
    const list = marmeon(webApp, ['route:list'], withoutSecrets);
    expect(list.code).toBe(1);
    expect(list.stderr).toContain('Invalid configuration — the application cannot start:\n  • app: APP_NAME');
  }, ciTimeout);

  it.runIf(process.env.MARMEON_TEST_PGSQL_URL)('shuts the app down after a command, so an open Postgres pool does not keep it running', () => {
    const { code, stdout } = marmeon(webApp, ['db:show'], { DB_CONNECTION: 'pgsql', DB_URL: process.env.MARMEON_TEST_PGSQL_URL! });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Target {6}pgsql postgres:\/\/marmeon:\*\*\*@localhost:55432\/marmeon\nServer {6}PostgreSQL \d+/);
  });

  it('prints a failing command’s error without Node’s dump and exits with 1', () => {
    const { code, stdout, stderr } = marmeon(webApp, ['db:show'], { DB_CONNECTION: 'pgsql', DB_URL: 'postgres://app:hunter2@127.0.0.1:1/app' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ DatabaseConnectionError: Could not connect to the database connection "default" \(pgsql postgres:\/\/app:\*\*\*@127\.0\.0\.1:1\/app\): .*ECONNREFUSED.*\n {2}at /);
    expect(stderr).not.toMatch(/\[cause\]|hunter2|Node\.js v/);
    expect(stdout).toBe('');
  });

  it('prints a command’s description, usage and options for --help, without running it', () => {
    const help = marmeon(webApp, ['make:controller', '--help']);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('Usage: marmeon make:controller <Name> --module=<module> [--view] [--request]');
    expect(help.stdout).toMatch(/^Options:\n {2}-m, --module=<value>\n {2}--force\n {2}--view\n {2}--request\n {2}-h, --help +Show this help$/m);
    // An app command (the app boots to know it), with -h; after -- it is an argument, not the help.
    const short = marmeon(webApp, ['route:list', '-h']);
    expect(short.code).toBe(0);
    expect(short.stdout).toMatch(/^List all registered routes|^Usage: marmeon route:list/m);
    expect(marmeon(webApp, ['route:list', '--', '--help']).stdout).not.toContain('Usage: marmeon route:list');
  });

  it('rejects unknown commands and invalid options', () => {
    expect(marmeon(webApp, ['nope']).stderr).toContain('Command "nope" is not defined');
    const invalid = marmeon(webApp, ['route:list', '--verbose']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Unknown option '--verbose'");
  });
});

describe('marmeon route:types (reserved page names)', () => {
  const blank = join(repo, 'apps/blank-app');

  function appWith(views: string[]): string {
    const app = realpathSync(tempDir('marmeon-views-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    for (const view of views) {
      mkdirSync(dirname(join(app, view)), { recursive: true });
      writeFileSync(join(app, view), 'export default function Page() { return null; }\n');
    }
    return app;
  }

  it('fails and names every page file whose path has "::"', () => {
    const app = appWith(['modules/a/views/x::y.tsx', 'modules/a/views/p::q/Show.tsx', 'modules/a/views/Fine.tsx']);
    const { code, stderr } = marmeon(app, ['route:types']);
    expect(code).toBe(1);
    expect(stderr).toContain('modules/a/views/x::y.tsx: "::" is reserved for the pages of packages (package::Page) — rename the file or its folder.');
    expect(stderr).toContain('modules/a/views/p::q/Show.tsx: "::" is reserved');
    expect(stderr).not.toContain('Fine.tsx');
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).not.toContain('::'); // left as it was
  }, ciTimeout);

  it('lists the pages of the app’s modules when none has "::"', () => {
    const app = appWith(['modules/a/views/Fine.tsx']);
    expect(marmeon(app, ['route:types']).code).toBe(0);
    expect(readFileSync(join(app, 'bootstrap/routes.ts'), 'utf8')).toContain("'a/Fine': true;");
  }, ciTimeout);
});

describe('marmeon: two commands with one name', () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithCommand(name: string): string {
    const app = realpathSync(tempDir('marmeon-names-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(
      join(app, 'modules/system/Ours.ts'),
      `export class OursCommand {\n  static command = '${name}';\n  static description = 'Ours';\n  handle() {\n    console.log('OURS RAN');\n  }\n}\n`,
    );
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { OursCommand } from './Ours.ts';\nexport default defineModule({ name: 'system', commands: [OursCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
    return app;
  }

  it('fails the start instead of running either command', () => {
    const app = appWithCommand('route:list');
    for (const args of [['route:list'], ['list']]) {
      const { code, stdout, stderr } = marmeon(app, args);
      expect(code).toBe(1);
      expect(stderr).toContain('Two commands are named "route:list": RouteListCommand (marmeon) and OursCommand (module system)');
      expect(stdout).not.toContain('OURS RAN');
    }
  }, ciTimeout);

  it('fails the start when a module reuses the name of a package command', () => {
    const app = appWithCommand('db:seed');
    for (const args of [['list'], ['db:seed']]) {
      const { code, stdout, stderr } = marmeon(app, args);
      expect(code).toBe(1);
      expect(stderr).toContain('Two commands are named "db:seed"');
      expect(stderr).toContain('@marmeon/database');
      expect(stdout).not.toContain('OURS RAN');
    }
  }, ciTimeout);

  it('starts when the names differ', () => {
    const app = appWithCommand('ours:run');
    const { code, stdout } = marmeon(app, ['ours:run']);
    expect(code).toBe(0);
    expect(stdout).toContain('OURS RAN');
  }, ciTimeout);
});

describe('marmeon modules:check (unlisted jobs and notifications)', () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithFiles(files: Record<string, string>): string {
    const app = realpathSync(tempDir('marmeon-unlisted-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), source);
    }
    return app;
  }

  it('warns about a hand-written job no module lists, and exits 0', () => {
    const app = appWithFiles({ 'modules/system/jobs/SendJob.ts': "export class SendJob {\n  static readonly job = 'system.send';\n}\n" });
    const { code, stderr } = marmeon(app, ['modules:check']);
    expect(code).toBe(0);
    expect(stderr).toContain("SendJob (static job 'system.send') is in no module's jobs");
  }, ciTimeout);

  it('stays quiet about generated jobs and notifications, which make:* registers, and warns when --no-register skips it', () => {
    const app = appWithFiles({});
    expect(marmeon(app, ['make:job', 'Send', '--module=system']).code).toBe(0);
    expect(marmeon(app, ['make:notification', 'Late', '--module=system']).code).toBe(0);
    const registered = marmeon(app, ['modules:check']);
    expect(registered.code).toBe(0);
    expect(registered.stderr).not.toContain('is in no module');
    expect(marmeon(app, ['make:job', 'Skipped', '--module=system', '--no-register']).code).toBe(0);
    expect(marmeon(app, ['modules:check']).stderr).toContain("(static job 'system.skipped') is in no module's jobs");
  }, ciTimeout);

  it('stays quiet without such a class, and stays out of `marmeon list`', () => {
    const app = appWithFiles({});
    const check = marmeon(app, ['modules:check']);
    expect(check.code).toBe(0);
    expect(check.stderr).not.toContain('is in no module');
    expect(marmeon(app, ['list']).stdout).not.toContain('modules:check');
  }, ciTimeout);
});

describe('marmeon make:* (generated code compiles)', () => {
  let app: string;

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-make-')));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    // Resolve the framework and React like an installed app would.
    const link = (name: string, target: string) => {
      mkdirSync(dirname(join(app, 'node_modules', name)), { recursive: true });
      symlinkSync(target, join(app, 'node_modules', name), 'dir');
    };
    for (const pkg of ['core', 'http', 'router', 'database', 'queue', 'notifications', 'validation']) link(`@marmeon/${pkg}`, join(repo, 'packages', pkg));
    link('marmeon', join(repo, 'packages', 'cli')); // the generated command imports its input type from it
    for (const pkg of ['react', '@types/react']) link(pkg, realpathSync(join(webApp, 'node_modules', pkg)));
    link('@types/node', realpathSync(join(repo, 'node_modules/@types/node'))); // the framework sources need them
    writeFileSync(
      join(app, 'tsconfig.json'),
      JSON.stringify({
        extends: join(repo, 'tsconfig.base.json'),
        compilerOptions: { noEmit: true, jsx: 'react-jsx', lib: ['ES2025', 'ESNext.Temporal', 'ESNext.TypedArrays', 'DOM'], types: ['node'] },
        include: ['modules'],
      }),
    );
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('scaffolds a module, controller with view, event, listener, middleware, job and notification', () => {
    expect(marmeon(app, ['make:module', 'billing']).stdout).toContain("import billing from '#modules/billing';");
    expect(marmeon(app, ['make:controller', 'ShowInvoice', '--module=billing', '--view']).code).toBe(0);
    expect(marmeon(app, ['make:event', 'InvoicePaid', '-m', 'billing']).code).toBe(0);
    expect(marmeon(app, ['make:listener', 'SendReceipt', '--event=InvoicePaid', '--module=billing']).stdout).toContain(
      '✓ Registered SendReceipt in modules/billing/index.ts (listeners)',
    );
    expect(marmeon(app, ['make:middleware', 'EnsureCustomer', '--module=billing']).code).toBe(0);
    expect(marmeon(app, ['make:job', 'SendInvoiceReminder', '--module=billing']).stdout).toContain(
      '✓ Registered SendInvoiceReminderJob in modules/billing/index.ts (jobs)',
    );
    expect(marmeon(app, ['make:notification', 'InvoiceOverdue', '--module=billing']).stdout).toContain(
      '✓ Registered InvoiceOverdueNotification in modules/billing/index.ts (notifications)',
    );
    expect(marmeon(app, ['make:command', 'PruneInvoices', '--module=billing']).stdout).toContain(
      '✓ Registered PruneInvoicesCommand in modules/billing/index.ts (commands)',
    );
    expect(marmeon(app, ['make:seeder', 'Invoice', '--module=billing']).stdout).toContain(
      '✓ Registered InvoiceSeeder in modules/billing/index.ts (seeders)',
    );
    expect(marmeon(app, ['make:controller', 'UpdateInvoice', '--module=billing', '--request']).stdout).toContain("Route.post('/…', UpdateInvoiceController)");
    // A reading endpoint is a GET, and a GET has no body: its request validates the query.
    expect(marmeon(app, ['make:controller', 'ListInvoices', '--module=billing', '--request']).stdout).toContain("Route.get('/…', ListInvoicesController)");
    // A writing endpoint answers with a redirect: it renders no page — --view goes with a reading name, nothing is written.
    const writing = marmeon(app, ['make:controller', 'ArchiveInvoice', '--module=billing', '--request', '--view']);
    expect([writing.code, writing.stderr]).toEqual([
      1,
      '✗ --view renders a page, and ArchiveInvoiceController answers a form with a redirect (--request on a name that does not read). Name a reading endpoint (Show…, List…, Index…, Search…, Get…, Find…, Browse…) for a page, or leave out --view.\n',
    ]);
    expect(existsSync(join(app, 'modules/billing/controllers/ArchiveInvoiceController.ts'))).toBe(false);
    expect(existsSync(join(app, 'modules/billing/views/ArchiveInvoice.tsx'))).toBe(false);
    expect(marmeon(app, ['make:migration', 'create_invoices_table', '--module=billing']).stdout).toContain(
      '✓ Registered the migrations folder in modules/billing/index.ts',
    );
    expect(marmeon(app, ['make:migration', 'add_due_date_to_invoices_table', '--module=billing']).code).toBe(0);
    expect(marmeon(app, ['make:migration', 'backfill_totals', '--module=billing']).code).toBe(0);
    expect(marmeon(app, ['make:migration', 'CreateInvoices', '--module=billing']).stderr).toContain('Pass a snake_case name');

    const controller = readFileSync(join(app, 'modules/billing/controllers/ShowInvoiceController.ts'), 'utf8');
    expect(controller).toContain("return this.view('billing/ShowInvoice', {});");
    expect(readFileSync(join(app, 'modules/billing/events/InvoicePaid.ts'), 'utf8')).toContain('readonly #event = true;');
    const job = readFileSync(join(app, 'modules/billing/jobs/SendInvoiceReminderJob.ts'), 'utf8');
    expect(job).toContain("static readonly job = 'billing.send-invoice-reminder';"); // stable, from the class name once
    expect(job).toContain('async handle(payload: JobPayload<typeof SendInvoiceReminderJob>, job: JobContext): Promise<void> {');
    const notification = readFileSync(join(app, 'modules/billing/notifications/InvoiceOverdueNotification.ts'), 'utf8');
    expect(notification).toContain("static readonly notification = 'billing.invoice-overdue';"); // stable, like a job's
    expect(notification).toContain('toDatabase(data: NotificationData<typeof InvoiceOverdueNotification>): DatabaseInput<typeof InvoiceOverdueNotification> {');
    const index = readFileSync(join(app, 'modules/billing/index.ts'), 'utf8');
    expect(index).toContain("import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';");
    expect(index).toContain("import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';");
    expect(index).toContain("import { InvoicePaid } from './events/InvoicePaid.ts';");
    expect(index).toContain("import { SendReceipt } from './listeners/SendReceipt.ts';");
    expect(index).toMatch(/listeners: \[listen\(InvoicePaid, SendReceipt\)\]/);
    expect(index).toContain("migrations: new URL('./migrations/', import.meta.url)");
    expect(index.match(/migrations:/g)).toHaveLength(1);
    expect(index).toMatch(/jobs: \[SendInvoiceReminderJob\]/);
    expect(index).toMatch(/notifications: \[InvoiceOverdueNotification\]/);
    expect(index).toMatch(/commands: \[PruneInvoicesCommand\]/);
    expect(index).toMatch(/seeders: \[InvoiceSeeder\]/);
    // The generated class passes the checks where a notification is sent (channels, toDatabase against static database).
    writeFileSync(
      join(app, 'modules/billing/send-overdue.ts'),
      [
        "import type { Notifications } from '@marmeon/notifications';",
        "import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';",
        "declare module '@marmeon/notifications' { interface NotificationRecipients { user: { readonly id: number } } }",
        'export const sendOverdue = (notifications: Notifications) => notifications.send({ type: \'user\', id: 7 }, InvoiceOverdueNotification, { id: 1 });',
        '',
      ].join('\n'),
    );
    const withRequest = readFileSync(join(app, 'modules/billing/controllers/UpdateInvoiceController.ts'), 'utf8');
    expect(withRequest).toContain('export const UpdateInvoiceRequest = defineRequest({');
    expect(withRequest).toContain('static request = UpdateInvoiceRequest;');
    expect(withRequest).toContain('handle(ctx: ContextOf<typeof UpdateInvoiceRequest>) {');
    expect(withRequest).toContain('  schema: r.object({');
    const withQuery = readFileSync(join(app, 'modules/billing/controllers/ListInvoicesController.ts'), 'utf8');
    expect(withQuery).toContain('  query: r.query({');
    expect(withQuery).not.toContain('schema:');
    expect(withQuery).toContain('return this.json({ q: ctx.query.q, page: ctx.query.page });');

    // Generated in quick succession, they still sort in the order they were made.
    const migrations = readdirSync(join(app, 'modules/billing/migrations')).sort();
    expect(migrations).toEqual([
      expect.stringMatching(/^\d{4}_\d\d_\d\d_\d{6}_create_invoices_table\.ts$/),
      expect.stringMatching(/^\d{4}_\d\d_\d\d_\d{6}_add_due_date_to_invoices_table\.ts$/),
      expect.stringMatching(/^\d{4}_\d\d_\d\d_\d{6}_backfill_totals\.ts$/),
    ]);
    expect(readFileSync(join(app, 'modules/billing/migrations', migrations[0]!), 'utf8')).toContain("schema.create('invoices', (table) => {");
    expect(readFileSync(join(app, 'modules/billing/migrations', migrations[1]!), 'utf8')).toContain("schema.alter('invoices', (table) => {");

    const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
    expect(typecheck.stdout + typecheck.stderr).toBe('');
    expect(typecheck.status).toBe(0);
  }, 30_000); // fifteen CLI processes — seconds under a full parallel run

  it('refuses to overwrite and explains missing modules', () => {
    marmeon(app, ['make:module', 'shop']);
    const again = marmeon(app, ['make:module', 'shop']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('modules/shop/index.ts already exists (use --force to overwrite)');

    const missing = marmeon(app, ['make:controller', 'ShowCart', '--module=cart']);
    expect(missing.stderr).toContain('Module "cart" does not exist. Create it first: marmeon make:module cart');
  }, ciTimeout);

  it('generates the application key into .env — without booting, never silently replacing one, rotating with --force', () => {
    writeFileSync(join(app, '.env.example'), 'APP_NAME=Shop\nAPP_KEY=\n');
    expect(marmeon(app, ['key:generate']).code).toBe(0);
    const env = readFileSync(join(app, '.env'), 'utf8');
    expect(env).toMatch(/^APP_NAME=Shop\nAPP_KEY=base64:[A-Za-z0-9+/]{43}=\n$/);

    const again = marmeon(app, ['key:generate']);
    expect(again.code).toBe(1);
    // What --force does: it keeps the old key for what it encrypted — the message must not say it breaks them.
    expect(again.stderr).toBe(
      '✗ APP_KEY is already set. --force replaces it and moves the old key to APP_PREVIOUS_KEYS, so sessions, encrypted cookies and signed links stay valid.\n',
    );
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(env);

    // --force rotates: the old key moves to APP_PREVIOUS_KEYS — what it encrypted stays readable.
    const first = /^APP_KEY=(.*)$/m.exec(env)![1]!;
    const rotated = marmeon(app, ['key:generate', '--force']);
    expect(rotated.code).toBe(0);
    expect(rotated.stdout).toContain('The old key moved to APP_PREVIOUS_KEYS');
    const second = readFileSync(join(app, '.env'), 'utf8');
    expect(second).toMatch(new RegExp(`^APP_NAME=Shop\nAPP_KEY=base64:[A-Za-z0-9+/]{43}=\nAPP_PREVIOUS_KEYS=${first.replaceAll('+', '\\+')}\n$`));
    expect(/^APP_KEY=(.*)$/m.exec(second)![1]).not.toBe(first);
    // Again: the newest old key first, none twice.
    const secondKey = /^APP_KEY=(.*)$/m.exec(second)![1]!;
    expect(marmeon(app, ['key:generate', '--force']).code).toBe(0);
    expect(/^APP_PREVIOUS_KEYS=(.*)$/m.exec(readFileSync(join(app, '.env'), 'utf8'))![1]).toBe(`${secondKey},${first}`);
    expect(marmeon(app, ['key:generate', '--show']).stdout).toMatch(/^base64:[A-Za-z0-9+/]{43}=\n$/);
  });

  it('runs generators without a bootable app (no bootstrap, no .env)', () => {
    expect(marmeon(app, ['make:event', 'CartEmptied', '--module=shop']).code).toBe(0);
    expect(marmeon(app, ['route:list']).stderr).toContain('No Marmeon app');
  });
});

/**
 * A workspace package copied under `node_modules` — what `pnpm deploy` (and injected workspace dependencies) leave: the copy keeps
 * the workspace manifest, whose `exports` name the source condition. It runs its `dist/` like a published package; started with
 * the source condition, Node would refuse its TypeScript (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 */
describe('marmeon from a copy of the workspace package (pnpm deploy)', () => {
  it('is no monorepo: no source condition, the built dist/', () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-deployed-')));
    try {
      const cli = join(app, 'node_modules/marmeon');
      // As pnpm deploy writes it: a workspace of the app alone — the copy under node_modules is none of its packages.
      writeFileSync(join(app, 'pnpm-workspace.yaml'), "packages:\n- '.'\ninjectWorkspacePackages: false\n");
      // The CLI copied with its workspace manifest and sources; its dependencies as installed (here: links to the built packages).
      for (const part of ['bin', 'src', 'dist', 'package.json']) cpSync(join(repo, 'packages/cli', part), join(cli, part), { recursive: true });
      mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true }); // the CLI is unscoped: nothing made the scope's directory
      for (const name of ['core', 'server', 'http', 'router', 'encryption', 'log']) symlinkSync(join(repo, 'packages', name), join(app, 'node_modules/@marmeon', name), 'dir');
      expect(readFileSync(join(cli, 'package.json'), 'utf8')).toContain('"@marmeon/source"');
      const { MARMEON_CHILD: _child, NODE_OPTIONS: _options, ...parent } = process.env;
      const result = spawnSync(process.execPath, [join(cli, 'bin/marmeon.js'), 'list'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, NODE_ENV: 'production' } });
      expect(result.stderr).not.toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
      expect(result.stdout).toContain('make:module');
      expect(result.status).toBe(0);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 30_000);

  it('knows the monorepo by its workspace, not by a manifest: a pnpm-workspace.yaml above the package lists its directory', async () => {
    const { inWorkspace, listedIn } = (await import(new URL('../bin/workspace.js', import.meta.url).href)) as { inWorkspace(dir: string): boolean; listedIn(yaml: string, path: string): boolean };
    expect(inWorkspace(join(repo, 'packages/cli'))).toBe(true);
    expect(inWorkspace(join(webApp, 'node_modules/marmeon'))).toBe(true); // the app's link resolves to the workspace package
    const yaml = "# the workspace\npackages:\n  - 'packages/*'\n  - \"apps/**\" # apps\n  - '!apps/legacy/**'\ncatalog:\n  - nope\n";
    expect(['packages/cli', 'apps/shop', 'apps/a/b'].map((path) => listedIn(yaml, path))).toEqual([true, true, true]);
    expect(['packages/cli/sub', 'apps/legacy/x', 'nope', 'node_modules/.pnpm/x/node_modules/marmeon', 'packages/node_modules'].map((path) => listedIn(yaml, path))).toEqual([false, false, false, false, false]);
    expect(listedIn("packages:\n- '.'\n", '')).toBe(false);
    expect(listedIn("packages:\n- packages/*\nother: 1\n", 'packages/cli')).toBe(true); // a sequence need not be indented
    expect(listedIn('onlyBuiltDependencies:\n  - esbuild\n', 'packages/cli')).toBe(false);
  });

  it('a package that brings its TypeScript sources: the start says Node’s code and how to fix it', () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-shipped-ts-')));
    try {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
      mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
      symlinkSync(join(repo, 'packages/core'), join(app, 'node_modules/@marmeon/core'), 'dir');
      mkdirSync(join(app, 'node_modules/shipped'));
      writeFileSync(join(app, 'node_modules/shipped/package.json'), JSON.stringify({ name: 'shipped', type: 'module', exports: './index.ts' }));
      writeFileSync(join(app, 'node_modules/shipped/index.ts'), 'export const value: number = 1;\n');
      mkdirSync(join(app, 'bootstrap'));
      writeFileSync(join(app, 'bootstrap/app.ts'), "import { join } from 'node:path';\nimport { defineApplication } from '@marmeon/core';\nimport 'shipped';\nexport default defineApplication({ root: join(import.meta.dirname, '..') });\n");
      const { code, stdout, stderr } = marmeon(app, ['route:list'], { NODE_ENV: 'production' });
      expect(code).toBe(1);
      expect(stderr).toContain('(ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)');
      expect(stdout).toContain('How to fix it: Install the package as it is published');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * `marmeon start`: one Node process — the server itself, no launcher in front, so a supervisor's SIGTERM reaches
 * it — and the `NODE_ENV` it is given (a missing one becomes production; one that is none of development, test, production does not
 * start), with `APP_ENV` naming the environment (a staging server: `NODE_ENV=production APP_ENV=staging`). An app of its own
 * that resolves the framework's built `dist/` like an installed one (`start` never uses the source condition).
 */
describe('marmeon start', () => {
  let app: string;
  const key = `base64:${Buffer.alloc(32, 3).toString('base64')}`;

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-start-')));
    const packages = ['core', 'encryption', 'http', 'router', 'server', 'log'];
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: Object.fromEntries(packages.map((name) => [`@marmeon/${name}`, '*'])) }));
    for (const name of packages) {
      mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
      symlinkSync(join(repo, 'packages', name), join(app, 'node_modules/@marmeon', name), 'dir');
    }
    // For the SSR bundle of the staging probe (not discovered: no dependency) — React resolves from the package's own folder.
    symlinkSync(join(repo, 'packages/react'), join(app, 'node_modules/@marmeon/react'), 'dir');
    mkdirSync(join(app, 'bootstrap'));
    mkdirSync(join(app, 'services'));
    // A class built by the container at boot: what it was injected with is in the output.
    writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock']));
    writeFileSync(
      join(app, 'bootstrap/app.ts'),
      [
        "import { join } from 'node:path';",
        "import { setTimeout as sleep } from 'node:timers/promises';",
        "import { defineApplication, defineModule, Logger, type Application } from '@marmeon/core';",
        "import { defineRoutes, view } from '@marmeon/http';",
        "import { Greeter } from '../services/Greeter.ts';",
        '// The logger as a service takes it while the app boots — its warnings later on are said.',
        'let bootLogger: Logger | undefined;',
        'class GreeterProvider {',
        '  boot(app: Application) {',
        "    if (process.env.GREETER_FAILS === '1' && process.env.MARMEON_CLUSTER_WORKER === '1') throw new Error('the greeter cannot boot in a worker');",
        '    console.log(`greeter: ${app.container.make(Greeter).describe()}`);',
        '    bootLogger = app.container.make(Logger);',
        '  }',
        '}',
        '// A request that takes a while — in flight when SIGTERM comes, it must still be answered.',
        '// A library loaded after the server listens — Rolldown, when Vite 8\'s dev server starts — with signal-exit: it re-raises a signal',
        '// when it finds itself the only listener.',
        'function loadSignalExit() {',
        "  for (const signal of ['SIGINT', 'SIGTERM'] as const) {",
        '    const listener = () => {',
        '      if (process.listeners(signal).length === 1) {',
        '        process.removeListener(signal, listener);',
        '        process.kill(process.pid, signal);',
        '      }',
        '    };',
        '    process.on(signal, listener);',
        '  }',
        '}',
        "const slow = defineModule({ name: 'slow', apiRoutes: defineRoutes((Route) => { Route.get('/slow', async () => { await sleep(600); return { pid: process.pid }; }); Route.get('/warn', () => { bootLogger?.warn('warned at runtime'); return { pid: process.pid }; }); Route.get('/signal-exit', () => { loadSignalExit(); return { pid: process.pid }; }); }) });",
        "// A page whose Suspense boundary fails after the shell (the staging probe's /lab/late-error).",
        "const late = defineModule({ name: 'late', routes: defineRoutes((Route) => { Route.get('/late-error', () => view('lab/LateError', {})); }) });",
        "export default defineApplication({ root: join(import.meta.dirname, '..'), providers: [GreeterProvider], modules: [slow, late] });",
        '',
      ].join('\n'),
    );
    // Which modules the start loaded — written when it exits.
    writeFileSync(
      join(app, 'loads.mjs'),
      "import { registerHooks } from 'node:module';\nimport { writeFileSync } from 'node:fs';\nconst urls = [];\nregisterHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });\nprocess.on('exit', () => writeFileSync(new URL('./loaded.json', import.meta.url), JSON.stringify(urls)));\n",
    );
    // What `marmeon build` leaves for the production renderer.
    mkdirSync(join(app, 'dist/client'), { recursive: true });
    mkdirSync(join(app, 'dist/server'), { recursive: true });
    writeFileSync(join(app, 'dist/client/index.html'), '<!doctype html><html><head></head><body><div id="app"></div></body></html>\n');
    writeFileSync(join(app, 'dist/server/ssr.js'), "export const render = async () => ({ html: '' });\n");
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  /**
   * `marmeon start` until `servers` servers listen, on the address the requests go to: `HOST=127.0.0.1`. On every interface
   * (`::`, no HOST) macOS lets the server — even with the port the system picked for it (`PORT=0`) — listen beside another program
   * that holds the same port on 127.0.0.1 only; a request to 127.0.0.1 then reaches that
   * program (a 404, a 501 from `/up`). Bound to 127.0.0.1 the start fails instead (EADDRINUSE). The requests go to `base`: the
   * address and port the start line names.
   */
  async function start(env: Record<string, string>, args: string[] = [], servers = 1) {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    const child = spawn(process.execPath, [bin, 'start', ...args], { cwd: app, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const listening = () => [...output.matchAll(/ on http:\/\/([^\s/]+):(\d+) /g)].map((match) => ({ host: match[1]!, port: Number(match[2]) }));
    const ports = () => listening().map(({ port }) => port);
    const deadline = Date.now() + 20_000;
    while (ports().length < servers) {
      if (child.exitCode !== null || Date.now() > deadline) {
        // A start that took too long must not outlive the test (a primary and its workers would keep running).
        child.kill('SIGTERM');
        throw new Error(`marmeon start did not start:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The workers of a cluster share the one port the primary got.
    expect(new Set(ports()).size).toBe(1);
    const { host, port } = listening()[0]!;
    return { child, port, base: `http://${host}:${port}`, exited, output: () => output };
  }

  it('is one process, runs a staging server as production named by APP_ENV — JSON logs with appEnv — and drains on SIGTERM', async () => {
    const server = await start({ NODE_ENV: 'production', APP_ENV: 'staging' });
    try {
      // No launcher, no child: the process that was started is the server.
      expect(spawnSync('pgrep', ['-P', String(server.child.pid)], { encoding: 'utf8' }).stdout).toBe('');
      expect((await fetch(`${server.base}/up`)).status).toBe(200);
      const line = server.output().split('\n').find((entry) => entry.includes('Marmeon in'))!;
      expect(JSON.parse(line).msg).toMatch(new RegExp(`^Marmeon in production \\(APP_ENV=staging\\) on http://127.0.0.1:${server.port} \\(the build; `));
      expect(JSON.parse(line).appEnv, 'the JSON log entry names the environment').toBe('staging');
    } finally {
      server.child.kill('SIGTERM');
    }
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('SIGTERM received, shutting down');
  }, 30_000);

  it('a library that re-raises a signal it is alone with (signal-exit, under Vite 8) does not end the server before its shutdown', async () => {
    const server = await start({ NODE_ENV: 'production' });
    try {
      expect((await fetch(`${server.base}/api/signal-exit`)).status).toBe(200);
    } finally {
      server.child.kill('SIGTERM');
    }
    // Not ended by the signal (exit code null) without "shutting down" — `marmeon dev` would leave its worker and scheduler.
    expect(await server.exited, server.output()).toBe(0);
    expect(server.output()).toContain('SIGTERM received, shutting down');
  }, 30_000);

  it('a SIGTERM while the server starts is answered once it listens: drained, exit 0 — not the end of the process', async () => {
    // The SSR bundle loads while startServer() runs, before the server listens: a supervisor's SIGTERM lands in that window.
    const ssr = join(app, 'dist/server/ssr.js');
    const original = readFileSync(ssr, 'utf8');
    writeFileSync(ssr, "console.log('ssr: loading');\nawait new Promise((resolve) => setTimeout(resolve, 800));\nexport const render = async () => ({ html: '' });\n");
    try {
      const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
      const child = spawn(process.execPath, [bin, 'start'], { cwd: app, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 20_000;
      while (!output.includes('ssr: loading')) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`marmeon start did not load the SSR bundle:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill('SIGTERM');
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(output).toMatch(/ on http:\/\/127\.0\.0\.1:\d+ /);
      expect(output).toContain('SIGTERM received, shutting down');
    } finally {
      writeFileSync(ssr, original);
    }
  }, 30_000);

  it('--workers=2: a primary and two servers on one port; SIGTERM reaches both, each drains its request, exit 0', async () => {
    // Without the build's injection lists every process boots with a warning — said once, by the primary, not by each worker.
    rmSync(join(app, '.marmeon/injections.json'), { force: true });
    const server = await start({ NODE_ENV: 'production' }, ['--workers=2'], 2);
    let slow: Promise<Response> | undefined;
    try {
      // The primary forked two workers (node:cluster) — no launcher, no other process.
      const workers = spawnSync('pgrep', ['-P', String(server.child.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
      expect(workers).toHaveLength(2);
      expect((await fetch(`${server.base}/up`)).status).toBe(200);
      // A worker's warnings after its boot are said (its boot's were not: the primary said them).
      expect((await fetch(`${server.base}/api/warn`)).status).toBe(200);
      // A request in flight in each worker (round-robin), then SIGTERM to the primary only — as `docker stop` sends it.
      slow = Promise.all([fetch(`${server.base}/api/slow`), fetch(`${server.base}/api/slow`)]).then(([a]) => a);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      server.child.kill('SIGTERM');
    }
    expect((await slow!).status).toBe(200);
    expect(await server.exited).toBe(0);
    const output = server.output();
    expect(output).toContain('Starting 2 workers (node:cluster, primary');
    expect(output).toContain('SIGTERM received, stopping 2 workers');
    // Each worker drained as one server does.
    expect(output.split('SIGTERM received, shutting down').length - 1).toBe(2);
    expect(output).not.toContain('ended with');
    expect(output.split('Build artifacts are missing').length - 1).toBe(1);
    expect(output.split('warned at runtime').length - 1).toBe(1);
  }, 30_000);

  it('a program on 127.0.0.1 at the server\'s port: the start fails (EADDRINUSE) — never a server beside it that the requests miss', async () => {
    // On every interface the server could start beside a program holding its port on 127.0.0.1, and `/up` would reach that
    // program (501). The helper binds the address it asks.
    const program = createHttpServer((_request, response) => {
      response.statusCode = 501;
      response.end();
    });
    await new Promise<void>((resolve) => program.listen(0, '127.0.0.1', resolve));
    const port = (program.address() as AddressInfo).port;
    try {
      const outcome = await start({ NODE_ENV: 'production', PORT: String(port) }).then(
        async (server) => {
          const status = (await fetch(`${server.base}/up`)).status;
          server.child.kill('SIGTERM');
          await server.exited;
          return `started beside the program on 127.0.0.1:${port} — ${server.base}/up answered ${status}`;
        },
        (error: Error) => error.message,
      );
      expect(outcome).toContain('EADDRINUSE');
    } finally {
      program.close();
    }
  }, 30_000);

  it('the workers\' mark left in the environment silences no single server: its boot warnings are said', async () => {
    rmSync(join(app, '.marmeon/injections.json'), { force: true });
    const server = await start({ NODE_ENV: 'production', MARMEON_CLUSTER_WORKER: '1' });
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('Build artifacts are missing');
  }, 30_000);

  it('a worker that cannot start stops the cluster with its exit code; --workers needs a number', async () => {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    // A cluster that hangs (the bug this test is for) must not outlive the test: each runs in a process group of its own, killed
    // whole when the test ends — also after a timeout, when the awaits below never return.
    const groups: number[] = [];
    onTestFinished(() => {
      for (const pid of groups) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ended already, workers and all
        }
      }
    });
    // The port is taken: every worker fails to listen — the cluster must end, not fork them forever.
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    try {
      const port = (busy.address() as AddressInfo).port;
      const failed = await new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(process.execPath, [bin, 'start', '--workers=2'], { cwd: app, detached: true, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' } });
        groups.push(child.pid!);
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        child.once('exit', (code) => (clearTimeout(timer), resolve({ code, output })));
      });
      expect(failed.output).toContain('ended before it listened');
      expect(failed.code).not.toBe(0);
    } finally {
      busy.close();
    }
    // A worker whose app fails to boot (a provider throws — LIVE_DRIVER=memory with --workers): it ends, and so does
    // the cluster — it neither hangs on its channel to the primary nor forks again.
    const booting = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, 'start', '--workers=2'], { cwd: app, detached: true, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production', GREETER_FAILS: '1' } });
      groups.push(child.pid!);
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
      child.once('exit', (code) => (clearTimeout(timer), resolve({ code, output })));
    });
    expect(booting.output).toContain('the greeter cannot boot in a worker');
    expect(booting.output).toMatch(/ended before it listened \(code 1\)/);
    expect(booting.code).toBe(1);
    const wrong = spawnSync(process.execPath, [bin, 'start', '--workers=0'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, NODE_ENV: 'production' } });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('--workers expects a number of processes from 1, like --workers=4 (got 0).');
  }, 30_000);

  it('SHUTDOWN_DELAY=1: after SIGTERM /up/ready 503 and requests answered for a second, then the drain; SIGINT skips it', async () => {
    const server = await start({ NODE_ENV: 'production', SHUTDOWN_DELAY: '1' });
    const base = server.base;
    const signalled = performance.now();
    server.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fetch(`${base}/up/ready`)).status).toBe(503);
    expect((await fetch(`${base}/up`)).status).toBe(200);
    expect((await fetch(`${base}/api/slow`)).status).toBe(200);
    expect(await server.exited).toBe(0);
    expect(performance.now() - signalled).toBeGreaterThanOrEqual(1000);
    expect(server.output()).toContain('SIGTERM received, shutting down — not ready any more, still answering for 1 s (SHUTDOWN_DELAY)');

    const interrupted = await start({ NODE_ENV: 'production', SHUTDOWN_DELAY: '5' });
    const stopped = performance.now();
    interrupted.child.kill('SIGINT');
    expect(await interrupted.exited).toBe(0);
    expect(performance.now() - stopped).toBeLessThan(3000);
  }, 30_000);

  it('takes NODE_ENV=development from .env when the process has none — and says loudly that start runs as development', () => {
    writeFileSync(join(app, '.env'), 'NODE_ENV=development\n');
    mkdirSync(join(app, 'modules')); // what development watches for new views
    try {
      const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
      // Development serves through Vite's dev server, which this app does not have — the warning comes first, before the server.
      const result = spawnSync(process.execPath, [bin, 'start'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, PORT: '0', LOG_LEVEL: 'info' } });
      expect(`${result.stdout}${result.stderr}`).toContain('NODE_ENV=development comes from .env, not from the environment: marmeon start runs with the development tools');
      // …and the failed start ends (the route-types watcher does not keep it alive).
      expect(result.stderr).toContain('Vite is not installed in this app.');
      expect(result.status).toBe(1);
    } finally {
      rmSync(join(app, 'modules'), { recursive: true });
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('the process NODE_ENV wins over .env — production stays production, no warning; APP_ENV of .env names it', async () => {
    writeFileSync(join(app, '.env'), 'NODE_ENV=development\nAPP_ENV=staging\n');
    try {
      const server = await start({ NODE_ENV: 'production' });
      server.child.kill('SIGTERM');
      expect(await server.exited).toBe(0);
      expect(server.output()).toContain(`Marmeon in production (APP_ENV=staging) on http://127.0.0.1:${server.port}`);
      expect(server.output()).not.toContain('comes from .env');
    } finally {
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('runs as production when NODE_ENV is missing', async () => {
    const server = await start({});
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('Marmeon in production (APP_ENV=production) on http://127.0.0.1:');
  }, 30_000);

  it('does not start with any other NODE_ENV — the start error names the way: NODE_ENV=production and APP_ENV', () => {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [bin, 'start'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', ...env } });
    const staging = run({ NODE_ENV: 'staging' });
    expect(staging.status).toBe(1);
    expect(staging.stdout, 'nothing of the app ran').toBe('');
    expect(staging.stderr).toContain('NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging.');
    expect(staging.stderr).not.toContain(' on http://');
    // From .env just the same — said so.
    writeFileSync(join(app, '.env'), 'NODE_ENV=staging\n');
    try {
      const fromDotEnv = run({});
      expect(fromDotEnv.status).toBe(1);
      expect(fromDotEnv.stderr).toContain('NODE_ENV=staging (in .env) is not an environment Node knows');
    } finally {
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('a staging server (NODE_ENV=production APP_ENV=staging) streams a late server-rendering error as its digest only — no message, no stack', async () => {
    // A real SSR bundle: React's server renderer, chosen by the process's NODE_ENV when it loads — the page's boundary fails after the shell.
    const ssr = join(app, 'dist/server/ssr.js');
    const template = join(app, 'dist/client/index.html');
    const originals = { ssr: readFileSync(ssr, 'utf8'), template: readFileSync(template, 'utf8') };
    writeFileSync(template, '<!doctype html><html><head></head><body><div id="app"><!--app-html--></div></body></html>\n');
    writeFileSync(
      ssr,
      [
        "import { createRequire } from 'node:module';",
        "import { createSsrRenderer } from '@marmeon/react/server';",
        "const { createElement, Suspense, use } = createRequire(import.meta.resolve('@marmeon/react/server'))('react');",
        'function LatePart({ failing }) {',
        '  use(failing);',
        '  return null;',
        '}',
        'function LateError() {',
        "  const failing = new Promise((_, reject) => setTimeout(() => reject(new Error('SECRET-MESSAGE of the late part')), 30));",
        "  return createElement('main', null, createElement('h1', null, 'Late error'), createElement(Suspense, { fallback: createElement('p', null, 'Loading the late part…') }, createElement(LatePart, { failing })));",
        '}',
        'export const render = createSsrRenderer(async () => LateError);',
        '',
      ].join('\n'),
    );
    try {
      const server = await start({ NODE_ENV: 'production', APP_ENV: 'staging' });
      try {
        expect(server.output()).toContain(`Marmeon in production (APP_ENV=staging) on http://127.0.0.1:${server.port}`);
        const response = await fetch(`${server.base}/late-error`, { headers: { accept: 'text/html' } });
        const html = await response.text();
        expect(response.status, server.output()).toBe(200);
        expect(html).toContain('<h1>Late error</h1>');
        // The boundary goes to the browser with the framework's digest — React's production build sends nothing else (its
        // development build, which any NODE_ENV but production loads, adds the message and the stack).
        for (const leak of ['SECRET-MESSAGE', 'at LatePart', 'ssr.js:']) expect(html, `the stream leaks ${leak}`).not.toContain(leak);
        expect(html).toContain('$RX("B:0","marmeon:ssr")');
        // The error itself goes to the log, not to the visitor.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(server.output()).toContain('failed in a Suspense boundary');
      } finally {
        server.child.kill('SIGTERM');
      }
      expect(await server.exited).toBe(0);
    } finally {
      writeFileSync(ssr, originals.ssr);
      writeFileSync(template, originals.template);
    }
  }, 30_000);

  /** One start until it listens, then SIGTERM: its output and the modules it loaded. */
  async function startOnce(env: Record<string, string> = {}) {
    rmSync(join(app, 'loaded.json'), { force: true });
    const server = await start({ NODE_OPTIONS: `--import=${join(app, 'loads.mjs')}`, ...env });
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    const loaded = JSON.parse(readFileSync(join(app, 'loaded.json'), 'utf8')) as string[];
    return { output: server.output(), loaded: (name: string) => loaded.some((url) => url.includes(`/node_modules/${name}/`) || url.includes(`/${name}@`)) };
  }

  it('applies the injection lists of marmeon build: no oxc-parser, no pino-pretty for JSON logs, and a compile cache', async () => {
    rmSync(join(app, 'storage'), { recursive: true, force: true });
    // What `marmeon build` leaves: the injection lists and the discovery manifest (discovering would parse .d.ts files with oxc).
    writeInjectionArtifacts({ root: app });
    writeManifest({ root: app, conditions: runtimeConditions([], '') });
    const { output, loaded } = await startOnce();
    expect(output).toContain('greeter: SystemClock');
    expect(output).not.toContain('Build artifacts');
    expect(loaded('oxc-parser')).toBe(false);
    expect(loaded('pino-pretty')).toBe(false);
    // Node's compile cache, written once the server listens.
    const cache = join(app, 'storage/framework/compile-cache');
    expect(readdirSync(cache).flatMap((version) => readdirSync(join(cache, version))).length).toBeGreaterThan(50);
  }, 30_000);

  it('derives the lists of a module changed after the build — on every start, with the compile cache warm — and says so once', async () => {
    writeInjectionArtifacts({ root: app });
    await startOnce(); // warms the compile cache with the module as built
    writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock', 'redactor: Redactor']));
    try {
      for (let run = 0; run < 2; run++) {
        const { output, loaded } = await startOnce();
        expect(output).toContain('greeter: SystemClock+Redactor');
        expect(output.split('Build artifacts are stale (1 file: services/Greeter.ts)').length - 1).toBe(1);
        expect(loaded('oxc-parser')).toBe(true);
      }
    } finally {
      writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock']));
    }
  }, 60_000);

  it('analyses what marmeon build never saw — a missing file, a module not in it — instead of failing', async () => {
    rmSync(join(app, '.marmeon/injections.json'), { force: true });
    const { output } = await startOnce();
    expect(output).toContain('greeter: SystemClock');
    expect(output).toContain('Build artifacts are missing (.marmeon/injections.json): the injection lists of 1 file (services/Greeter.ts)');
  }, 30_000);

  it('starts without the compile cache when its directory cannot be written', async () => {
    rmSync(join(app, 'storage'), { recursive: true, force: true });
    mkdirSync(join(app, 'storage'));
    chmodSync(join(app, 'storage'), 0o555);
    try {
      const { output } = await startOnce();
      expect(output).toContain('greeter: SystemClock');
      expect(existsSync(join(app, 'storage/framework'))).toBe(false);
    } finally {
      chmodSync(join(app, 'storage'), 0o755);
    }
  }, 30_000);
});

/**
 * Where NODE_ENV comes from: the process's, else the app's `.env` — what a developer's machine has (`NODE_ENV=development`
 * from `.env.example`). A copy of the blank app with a `.env` of its own; the commands run without a NODE_ENV of the process.
 */
describe('marmeon dev: its companions', () => {
  let app: string;

  beforeAll(() => {
    // An app with a long-running command — what `marmeon dev` runs beside the server (the queue worker): it stops on SIGTERM.
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-companion-')));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@marmeon/core': '*', marmeon: '*' } }));
    mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
    symlinkSync(join(repo, 'packages/core'), join(app, 'node_modules/@marmeon/core'), 'dir');
    symlinkSync(join(repo, 'packages/cli'), join(app, 'node_modules/marmeon'), 'dir');
    mkdirSync(join(app, 'bootstrap'));
    writeFileSync(
      join(app, 'bootstrap/app.ts'),
      [
        "import { join } from 'node:path';",
        "import { defineApplication, defineModule } from '@marmeon/core';",
        'class WaitCommand {',
        "  static command = 'wait';",
        "  static description = 'Wait for SIGTERM';",
        '  async handle({ output }: { output: { line(text: string): void } }) {',
        "    const stopped = new Promise((resolve) => process.on('SIGTERM', resolve));",
        '    const alive = setInterval(() => {}, 1000);',
        '    output.line(`waiting ${process.pid}`);',
        '    await stopped;',
        '    clearInterval(alive);',
        '    output.line(`stopped by SIGTERM ${process.pid}`);',
        '    return 0;',
        '  }',
        '}',
        "export default defineApplication({ root: join(import.meta.dirname, '..'), modules: [defineModule({ name: 'waiting', commands: [WaitCommand] })] });",
        '',
      ].join('\n'),
    );
    // What `serve` does for each companion (startMarmeon) — in a process the test then kills.
    writeFileSync(
      join(app, 'server.mjs'),
      `import { startMarmeon } from ${JSON.stringify(join(repo, 'packages/cli/src/spawn.ts'))};\nconst child = startMarmeon(process.cwd(), ['wait']);\nconsole.log('companion ' + child.pid);\nsetInterval(() => {}, 1000);\n`,
    );
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('a companion stops by itself — as on SIGTERM — when its server ends without stopping it (killed, crashed)', async () => {
    // Its own process group, so that the test sees every process of the tree by PID — and ends what is left of it.
    const { MARMEON_CHILD: _child, NODE_OPTIONS: _options, ...parent } = process.env;
    const server = spawn(process.execPath, [join(app, 'server.mjs')], { cwd: app, detached: true, env: { ...parent, NODE_ENV: 'development', NO_COLOR: '1', APP_KEY: `base64:${Buffer.alloc(32, 4).toString('base64')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    server.stdout.on('data', (chunk) => (output += chunk));
    server.stderr.on('data', (chunk) => (output += chunk));
    const group = () =>
      spawnSync('ps', ['-o', 'pid=', '-g', String(server.pid)], { encoding: 'utf8' })
        .stdout.trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    onTestFinished(() => {
      for (const pid of group()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ended meanwhile
        }
      }
    });
    const deadline = Date.now() + 20_000;
    while (!/waiting \d+/.test(output)) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`the companion did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The server, the companion's launcher and — in the monorepo — the launcher's Node with the source condition.
    expect(group().length, output).toBeGreaterThanOrEqual(2);
    process.kill(server.pid!, 'SIGKILL'); // the server ends without any shutdown
    const until = Date.now() + 15_000;
    while (group().length > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(group(), `left running after its server was killed:\n${output}`).toEqual([]);
    // It ran its own shutdown — the command saw SIGTERM —, it was not killed.
    expect(output).toMatch(/stopped by SIGTERM \d+/);
  }, 40_000);
});

describe('NODE_ENV from the app’s .env', () => {
  let app: string;
  const blank = join(repo, 'apps/blank-app');
  const config = (dir: string) => `APP_NAME=Blank\nAPP_URL=http://localhost\nAPP_KEY=base64:${Buffer.alloc(32, 5).toString('base64')}\nDB_DATABASE=${join(dir, 'db.sqlite')}\nMAIL_MAILER=array\n`;
  const inApp = (args: string[], env: Record<string, string> = {}) => marmeon(app, args, { NODE_ENV: '', ...env });

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-dotenv-')));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('a developer migrates without --force: NODE_ENV=development from .env, table types written, the worker warns', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=development\n${config(app)}`);
    rmSync(join(app, 'bootstrap/database.d.ts'), { force: true });
    const migrate = inApp(['migrate']);
    expect(migrate.stdout).toContain('Environment: development (APP_ENV=local, NODE_ENV from .env)\n');
    expect(migrate.stdout).toContain('Wrote bootstrap/database.d.ts');
    expect(migrate.code).toBe(0);
    expect(existsSync(join(app, 'bootstrap/database.d.ts'))).toBe(true);
    // A production command as development because of .env: said, not refused.
    const worker = inApp(['queue:work', '--stop-when-empty']);
    expect(worker.code).toBe(0);
    expect(`${worker.stdout}${worker.stderr}`).toContain('NODE_ENV=development comes from .env, not from the environment: marmeon queue:work runs with the development tools');
    expect(worker.stdout).toContain('— in development (APP_ENV=local, NODE_ENV from .env)');
  }, 30_000);

  it('the process NODE_ENV wins over .env', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=development\n${config(app)}`);
    const production = inApp(['migrate'], { NODE_ENV: 'production' });
    expect(production.code).toBe(1);
    expect(production.stdout).toContain('Environment: production (APP_ENV=production)\n');
    expect(production.stderr).toContain('Pass --force to migrate');
  }, 30_000);

  it('ignores NODE_ENV in .env.{NODE_ENV} — and without NODE_ENV anywhere the app is protected', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=production\nAPP_ENV=qa\n${config(app)}`);
    writeFileSync(join(app, '.env.production'), 'NODE_ENV=development\nAPP_ENV=staging\n');
    try {
      const staging = inApp(['migrate']);
      expect(staging.stderr).toContain('NODE_ENV in .env.production is ignored: .env.production is chosen by NODE_ENV and cannot set it');
      // APP_ENV as the configuration layers it: .env.production over .env.
      expect(staging.stdout).toContain('Environment: production (APP_ENV=staging, NODE_ENV from .env)\n');
      expect(staging.code).toBe(1);
    } finally {
      rmSync(join(app, '.env.production'));
    }
    writeFileSync(join(app, '.env'), config(app));
    const unset = inApp(['migrate']);
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('The application is protected (production (APP_ENV=production, NODE_ENV unset)). Pass --force to migrate');
  }, 30_000);
});

/** The fixture's `services/Greeter.ts`, whose constructor takes `parameters` (a `Clock`, maybe a `Redactor`). */
function greeter(parameters: string[]): string {
  return [
    "import { Clock, Redactor } from '@marmeon/core';",
    'export class Greeter {',
    '  readonly #parts: object[];',
    `  constructor(${parameters.join(', ')}) {`,
    `    this.#parts = [${parameters.map((parameter) => parameter.split(':')[0]).join(', ')}];`,
    '  }',
    '  describe(): string {',
    "    return this.#parts.map((part) => part.constructor.name).join('+');",
    '  }',
    '}',
    "export type Unused = Redactor;",
    '',
  ].join('\n');
}
