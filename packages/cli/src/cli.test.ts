import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConditions, writeInjectionArtifacts, writeManifest } from '@bespokecore/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Slow under load (it hit Vitest's 5 s on a fully loaded machine): more time on CI runners only (CI=true, W8 step 1).
const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(repo, 'packages/cli/bin/bespoke.js');
const webApp = join(repo, 'apps/web-app');
const tsc = join(repo, 'node_modules/.bin/tsc');

function bespoke(cwd: string, args: string[], env: Record<string, string> = {}) {
  // The launcher must re-exec, not think it is the child; and the web app here is the SQLite app of
  // .env.test — `pnpm test:pgsql` points app tests at Postgres, commands get that only when a test says so.
  const { BESPOKE_CHILD: _child, DB_CONNECTION: _connection, DB_URL: _url, ...parent } = process.env;
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...parent, NO_COLOR: '1', ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('bespoke (in the web app)', () => {
  it('lists commands grouped by namespace', () => {
    const { code, stdout } = bespoke(webApp, []);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^ {2}dev\s+Start the development server/m);
    expect(stdout).toMatch(/^make\n(?: {2}make:.*\n)+/m);
    expect(stdout).toContain('route:list');
    expect(stdout).toContain('db:show');
    expect(stdout).not.toMatch(/^ {2}serve\b/m); // internal
  });

  it('lists routes through a command that gets the Router injected', () => {
    const { code, stdout } = bespoke(webApp, ['route:list']);
    expect(code).toBe(0);
    // Execution order: global first, then the web group (cookies before the session), the route's own last.
    expect(stdout).toMatch(
      /GET\s+\/users\/:user\s+user-profile\.show\s+web\s+SecurityHeaders, ContentSecurityPolicy, LimitLiveValidation, EncryptCookies, ClearClientHistory, StartSession, NoStoreWhenSignedIn, .*ShareAppProps, authenticate\s+ShowUserProfileController/,
    );
    expect(stdout).toMatch(/GET\s+\/api\/users\s+api\.users\.index\s+api\s+SecurityHeaders, ContentSecurityPolicy, LimitLiveValidation, authenticate:api, abilities:users:read\s+ListUsersController/);
    expect(stdout).toMatch(/\n\d+ routes\n$/); // the count grows with the app
  });

  it('prints configuration errors without Node internals and exits with 1', () => {
    const { code, stderr } = bespoke(webApp, ['route:list'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ Invalid configuration — the application cannot start:\n {2}• app: APP_NAME/);
    expect(stderr).not.toMatch(/triggerUncaughtException|node:internal/);
  });

  it('says how to fix an error the app cannot start with — the solutions as text (E130)', () => {
    const { code, stdout } = bespoke(webApp, ['route:list'], { APP_KEY: '' });
    expect(code).toBe(1);
    // The installed package's solution (encryption) first, then the core's.
    expect(stdout).toContain('How to fix it: Generate an application key');
    expect(stdout).toContain('  $ bespoke key:generate');
    expect(stdout).toContain('How to fix it: Set APP_KEY in .env');
  });

  it('shows the database connection (db:show, added by @bespokecore/database)', () => {
    const { code, stdout } = bespoke(webApp, ['db:show'], { DB_DATABASE: ':memory:' });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Connection {2}default\nTarget {6}sqlite :memory:\nServer {6}SQLite 3\.\d+/m);
    expect(stdout).toContain('No tables yet.');
  });

  it('runs the modules’ migrations in timestamp order (migrate, migrate:status)', () => {
    const memory = { DB_DATABASE: ':memory:' }; // every process starts empty
    const status = bespoke(webApp, ['migrate:status'], memory);
    expect(status.stdout).toMatch(
      /2026_10_01_120000_create_users_table\s+auth\s+Pending\n2026_10_01_120100_create_login_activity_table\s+user-profile\s+Pending\n2026_10_01_120101_create_profile_links_table\s+user-profile\s+Pending/,
    );
    const migrate = bespoke(webApp, ['migrate'], memory);
    expect(migrate.code).toBe(0);
    // Every module's migrations, in timestamp order (the list grows with the app) …
    const ran = [...migrate.stdout.matchAll(/^✓ Migrated (\d{4}_\d\d_\d\d_\d{6}_\w+) \(([\w-]+)\) [\d.]+ ms$/gm)].map((match) => match[1]!);
    expect(ran.slice(0, 3)).toEqual(['2026_10_01_120000_create_users_table', '2026_10_01_120100_create_login_activity_table', '2026_10_01_120101_create_profile_links_table']);
    expect(ran).toEqual(ran.toSorted());
    // It names the environment it assumed — and a test writes no table types (E164: development only).
    expect(migrate.stdout).toMatch(/^Environment: test\n/);
    expect(migrate.stdout).not.toContain('database.d.ts');
  });

  it('asks for --force wherever the app is protected — staging and a missing NODE_ENV too — and writes table types in development only (E139, E164)', () => {
    const memory = { DB_DATABASE: ':memory:' };
    // Outside NODE_ENV=test the app reads .env, which CI does not have: what it needs to boot comes from here.
    const key = /^APP_KEY=(.*)$/m.exec(readFileSync(join(webApp, '.env.test'), 'utf8'))![1]!;
    const config = { ...memory, SYSTEM_DB_DATABASE: ':memory:', APP_NAME: 'BespokeCore', APP_URL: 'http://localhost', APP_KEY: key, DEVTOOLS_ENABLED: 'false' };
    // Development regenerates the table types (already committed, so unchanged).
    const development = bespoke(webApp, ['migrate'], { ...config, NODE_ENV: 'development' });
    expect(development.stdout).toMatch(/ℹ bootstrap\/database\.d\.ts is up to date\.\n$/);
    expect(bespoke(webApp, ['migrate:fresh'], { ...config, NODE_ENV: 'production' }).stderr).toContain('The application is protected (production (protected)). Pass --force to drop every table — or, on a development machine, set NODE_ENV=development (in .env or the environment).');
    // Fail-closed (E139): staging and a missing NODE_ENV ask for --force too; with it, staging migrates — and writes no types.
    const staging = bespoke(webApp, ['migrate'], { ...config, NODE_ENV: 'staging' });
    expect(staging.code).toBe(1);
    expect(staging.stdout).toContain('Environment: staging (protected)\n');
    expect(staging.stdout).not.toContain('Migrated');
    expect(staging.stderr).toContain('Pass --force to migrate — or, on a development machine, set NODE_ENV=development (in .env or the environment).');
    const forced = bespoke(webApp, ['migrate', '--force'], { ...config, NODE_ENV: 'staging' });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('Migrated 2026_10_01_120000_create_users_table');
    expect(forced.stdout).not.toContain('database.d.ts');
  }, 30_000);

  it('migrates from scratch and seeds (migrate:fresh --seed, db:seed)', () => {
    const fresh = bespoke(webApp, ['migrate:fresh', '--seed', '--no-types'], { DB_DATABASE: ':memory:' });
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toMatch(/✓ Seeded DemoUsersSeeder \(auth\) [\d.]+ ms\n✓ Seeded DemoLinksSeeder \(user-profile\) [\d.]+ ms\n$/);
    const unknown = bespoke(webApp, ['db:seed', '--class=Nope'], { DB_DATABASE: ':memory:' });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe('✗ There is no seeder "Nope".\n');
  });

  it('checks that the committed table types match the migrations (db:types --check, as in CI)', () => {
    const { code, stdout } = bespoke(webApp, ['db:types', '--check'], { DB_DATABASE: ':memory:' });
    expect(stdout).toContain('✓ bootstrap/database.d.ts matches the migrations.');
    expect(code).toBe(0);
  });

  it('checks that the committed route types match the routes and views (route:types --check, as in CI)', () => {
    const { code, stdout } = bespoke(webApp, ['route:types', '--check']);
    expect(stdout).toContain('✓ bootstrap/routes.ts matches the routes and views.');
    expect(code).toBe(0);
  });

  it.runIf(process.env.BESPOKE_TEST_PGSQL_URL)('shuts the app down after a command, so an open Postgres pool does not keep it running', () => {
    const { code, stdout } = bespoke(webApp, ['db:show'], { DB_CONNECTION: 'pgsql', DB_URL: process.env.BESPOKE_TEST_PGSQL_URL! });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Target {6}pgsql postgres:\/\/bespoke:\*\*\*@localhost:55432\/bespoke\nServer {6}PostgreSQL \d+/);
  });

  it('prints a failing command’s error without Node’s dump and exits with 1', () => {
    const { code, stdout, stderr } = bespoke(webApp, ['db:show'], { DB_CONNECTION: 'pgsql', DB_URL: 'postgres://app:hunter2@127.0.0.1:1/app' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ DatabaseConnectionError: Could not connect to the database connection "default" \(pgsql postgres:\/\/app:\*\*\*@127\.0\.0\.1:1\/app\): .*ECONNREFUSED.*\n {2}at /);
    expect(stderr).not.toMatch(/\[cause\]|hunter2|Node\.js v/);
    expect(stdout).toBe('');
  });

  it('rejects unknown commands and invalid options', () => {
    expect(bespoke(webApp, ['nope']).stderr).toContain('Command "nope" is not defined');
    const invalid = bespoke(webApp, ['route:list', '--verbose']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Unknown option '--verbose'");
  });
});

describe('bespoke make:* (generated code compiles)', () => {
  let app: string;

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-make-')));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    // Resolve the framework and React like an installed app would.
    const link = (name: string, target: string) => {
      mkdirSync(dirname(join(app, 'node_modules', name)), { recursive: true });
      symlinkSync(target, join(app, 'node_modules', name), 'dir');
    };
    for (const pkg of ['core', 'http', 'router', 'database', 'queue', 'notifications']) link(`@bespokecore/${pkg}`, join(repo, 'packages', pkg));
    for (const pkg of ['react', '@types/react', 'valibot']) link(pkg, realpathSync(join(webApp, 'node_modules', pkg)));
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
    expect(bespoke(app, ['make:module', 'billing']).stdout).toContain("import billing from '#modules/billing';");
    expect(bespoke(app, ['make:controller', 'ShowInvoice', '--module=billing', '--view']).code).toBe(0);
    expect(bespoke(app, ['make:event', 'InvoicePaid', '-m', 'billing']).code).toBe(0);
    expect(bespoke(app, ['make:listener', 'SendReceipt', '--event=InvoicePaid', '--module=billing']).stdout).toContain(
      'listeners: [listen(InvoicePaid, SendReceipt)]',
    );
    expect(bespoke(app, ['make:middleware', 'EnsureCustomer', '--module=billing']).code).toBe(0);
    expect(bespoke(app, ['make:job', 'SendInvoiceReminder', '--module=billing']).stdout).toContain('jobs: [SendInvoiceReminderJob]');
    expect(bespoke(app, ['make:notification', 'InvoiceOverdue', '--module=billing']).stdout).toContain('notifications: [InvoiceOverdueNotification]');
    expect(bespoke(app, ['make:controller', 'UpdateInvoice', '--module=billing', '--request']).stdout).toContain("Route.post('/…', UpdateInvoiceController)");
    // A reading endpoint is a GET, and a GET has no body (E65): its request validates the query.
    expect(bespoke(app, ['make:controller', 'ListInvoices', '--module=billing', '--request']).stdout).toContain("Route.get('/…', ListInvoicesController)");
    expect(bespoke(app, ['make:migration', 'create_invoices_table', '--module=billing']).stdout).toContain(
      "migrations: new URL('./migrations/', import.meta.url)",
    );
    expect(bespoke(app, ['make:migration', 'add_due_date_to_invoices_table', '--module=billing']).code).toBe(0);
    expect(bespoke(app, ['make:migration', 'backfill_totals', '--module=billing']).code).toBe(0);
    expect(bespoke(app, ['make:migration', 'CreateInvoices', '--module=billing']).stderr).toContain('Pass a snake_case name');

    const controller = readFileSync(join(app, 'modules/billing/controllers/ShowInvoiceController.ts'), 'utf8');
    expect(controller).toContain("return this.view('billing/ShowInvoice', {});");
    expect(readFileSync(join(app, 'modules/billing/events/InvoicePaid.ts'), 'utf8')).toContain('readonly #event = true;');
    const job = readFileSync(join(app, 'modules/billing/jobs/SendInvoiceReminderJob.ts'), 'utf8');
    expect(job).toContain("static readonly job = 'billing.send-invoice-reminder';"); // stable, from the class name once (E84)
    expect(job).toContain('async handle(payload: JobPayload<typeof SendInvoiceReminderJob>, job: JobContext): Promise<void> {');
    const notification = readFileSync(join(app, 'modules/billing/notifications/InvoiceOverdueNotification.ts'), 'utf8');
    expect(notification).toContain("static readonly notification = 'billing.invoice-overdue';"); // stable, like a job's (E92)
    expect(notification).toContain('toDatabase(data: NotificationData<typeof InvoiceOverdueNotification>): DatabaseInput<typeof InvoiceOverdueNotification> {');
    // The generated class passes the checks where a notification is sent (channels, toDatabase against static database).
    writeFileSync(
      join(app, 'modules/billing/send-overdue.ts'),
      [
        "import type { Notifications } from '@bespokecore/notifications';",
        "import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';",
        "declare module '@bespokecore/notifications' { interface NotificationRecipients { user: { readonly id: number } } }",
        'export const sendOverdue = (notifications: Notifications) => notifications.send({ type: \'user\', id: 7 }, InvoiceOverdueNotification, { id: 1 });',
        '',
      ].join('\n'),
    );
    const withRequest = readFileSync(join(app, 'modules/billing/controllers/UpdateInvoiceController.ts'), 'utf8');
    expect(withRequest).toContain('export const UpdateInvoiceRequest = defineRequest({');
    expect(withRequest).toContain('static request = UpdateInvoiceRequest;');
    expect(withRequest).toContain('handle(ctx: ContextOf<typeof UpdateInvoiceRequest>) {');
    expect(withRequest).toContain('  schema: v.object({');
    const withQuery = readFileSync(join(app, 'modules/billing/controllers/ListInvoicesController.ts'), 'utf8');
    expect(withQuery).toContain('  query: v.object({');
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
  }, 30_000); // thirteen CLI processes — seconds under a full parallel run (it timed out at 5 s with test:pgsql)

  it('refuses to overwrite and explains missing modules', () => {
    bespoke(app, ['make:module', 'shop']);
    const again = bespoke(app, ['make:module', 'shop']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('modules/shop/index.ts already exists (use --force to overwrite)');

    const missing = bespoke(app, ['make:controller', 'ShowCart', '--module=cart']);
    expect(missing.stderr).toContain('Module "cart" does not exist. Create it first: bespoke make:module cart');
  }, ciTimeout);

  it('generates the application key into .env — without booting, and never silently replacing one', () => {
    writeFileSync(join(app, '.env.example'), 'APP_NAME=Shop\nAPP_KEY=\n');
    expect(bespoke(app, ['key:generate']).code).toBe(0);
    const env = readFileSync(join(app, '.env'), 'utf8');
    expect(env).toMatch(/^APP_NAME=Shop\nAPP_KEY=base64:[A-Za-z0-9+/]{43}=\n$/);

    const again = bespoke(app, ['key:generate']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('APP_KEY is already set');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(env);

    expect(bespoke(app, ['key:generate', '--force']).code).toBe(0);
    expect(readFileSync(join(app, '.env'), 'utf8')).not.toBe(env);
    expect(bespoke(app, ['key:generate', '--show']).stdout).toMatch(/^base64:[A-Za-z0-9+/]{43}=\n$/);
  });

  it('runs generators without a bootable app (no bootstrap, no .env)', () => {
    expect(bespoke(app, ['make:event', 'CartEmptied', '--module=shop']).code).toBe(0);
    expect(bespoke(app, ['route:list']).stderr).toContain('No BespokeCore app');
  });
});

/**
 * `bespoke start` (E139, E159): one Node process — the server itself, no launcher in front, so a supervisor's SIGTERM reaches
 * it — and the `NODE_ENV` it is given (staging stays staging, protected; a missing one becomes production). An app of its own
 * that resolves the framework's built `dist/` like an installed one (`start` never uses the source condition).
 */
describe('bespoke start', () => {
  let app: string;
  const key = `base64:${Buffer.alloc(32, 3).toString('base64')}`;

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-start-')));
    const packages = ['core', 'encryption', 'http', 'router', 'server', 'log'];
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: Object.fromEntries(packages.map((name) => [`@bespokecore/${name}`, '*'])) }));
    for (const name of packages) {
      mkdirSync(join(app, 'node_modules/@bespokecore'), { recursive: true });
      symlinkSync(join(repo, 'packages', name), join(app, 'node_modules/@bespokecore', name), 'dir');
    }
    mkdirSync(join(app, 'bootstrap'));
    mkdirSync(join(app, 'services'));
    // A class built by the container at boot: what it was injected with is in the output (E138).
    writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock']));
    writeFileSync(
      join(app, 'bootstrap/app.ts'),
      [
        "import { join } from 'node:path';",
        "import { defineApplication, type Application } from '@bespokecore/core';",
        "import { Greeter } from '../services/Greeter.ts';",
        'class GreeterProvider {',
        '  boot(app: Application) {',
        '    console.log(`greeter: ${app.container.make(Greeter).describe()}`);',
        '  }',
        '}',
        "export default defineApplication({ root: join(import.meta.dirname, '..'), providers: [GreeterProvider] });",
        '',
      ].join('\n'),
    );
    // Which modules the start loaded — written when it exits.
    writeFileSync(
      join(app, 'loads.mjs'),
      "import { registerHooks } from 'node:module';\nimport { writeFileSync } from 'node:fs';\nconst urls = [];\nregisterHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });\nprocess.on('exit', () => writeFileSync(new URL('./loaded.json', import.meta.url), JSON.stringify(urls)));\n",
    );
    // What `bespoke build` leaves for the production renderer.
    mkdirSync(join(app, 'dist/client'), { recursive: true });
    mkdirSync(join(app, 'dist/server'), { recursive: true });
    writeFileSync(join(app, 'dist/client/index.html'), '<!doctype html><html><head></head><body><div id="app"></div></body></html>\n');
    writeFileSync(join(app, 'dist/server/ssr.js'), "export const render = async () => ({ html: '' });\n");
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  async function start(env: Record<string, string>) {
    const { BESPOKE_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    const port = 39_000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, [bin, 'start'], { cwd: app, env: { ...parent, APP_KEY: key, PORT: String(port), LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (!output.includes(`on http://localhost:${port}`)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`bespoke start did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { child, port, exited, output: () => output };
  }

  it('is one process, respects NODE_ENV=staging — protected, JSON logs — and drains on SIGTERM (E139, E159, E102)', async () => {
    const server = await start({ NODE_ENV: 'staging' });
    try {
      // No launcher, no child: the process that was started is the server.
      expect(spawnSync('pgrep', ['-P', String(server.child.pid)], { encoding: 'utf8' }).stdout).toBe('');
      expect((await fetch(`http://127.0.0.1:${server.port}/up`)).status).toBe(200);
      const line = server.output().split('\n').find((entry) => entry.includes('BespokeCore in'))!;
      expect(JSON.parse(line).msg).toMatch(new RegExp(`^BespokeCore in staging \\(protected\\) on http://localhost:${server.port} \\(the build; `));
    } finally {
      server.child.kill('SIGTERM');
    }
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('SIGTERM received, shutting down');
  }, 30_000);

  it('takes NODE_ENV=development from .env when the process has none — and says loudly that start runs as development (E170)', () => {
    writeFileSync(join(app, '.env'), 'NODE_ENV=development\n');
    mkdirSync(join(app, 'modules')); // what development watches for new views
    try {
      const { BESPOKE_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
      // Development serves through Vite's dev server, which this app does not have — the warning comes first, before the server.
      const result = spawnSync(process.execPath, [bin, 'start'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, PORT: '39999', LOG_LEVEL: 'info' } });
      expect(`${result.stdout}${result.stderr}`).toContain('NODE_ENV=development comes from .env, not from the environment: bespoke start runs with the development tools');
      // …and the failed start ends (the route-types watcher kept it alive until it was killed).
      expect(result.stderr).toContain('Vite is not installed in this app.');
      expect(result.status).toBe(1);
    } finally {
      rmSync(join(app, 'modules'), { recursive: true });
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('the process NODE_ENV wins over .env — staging stays staging, no warning (E170)', async () => {
    writeFileSync(join(app, '.env'), 'NODE_ENV=development\n');
    try {
      const server = await start({ NODE_ENV: 'staging' });
      server.child.kill('SIGTERM');
      expect(await server.exited).toBe(0);
      expect(server.output()).toContain(`BespokeCore in staging (protected) on http://localhost:${server.port}`);
      expect(server.output()).not.toContain('comes from .env');
    } finally {
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('runs as production when NODE_ENV is missing', async () => {
    const server = await start({});
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('BespokeCore in production (protected) on http://localhost:');
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

  it('applies the injection lists of bespoke build: no oxc-parser, no pino-pretty for JSON logs, and a compile cache (E138)', async () => {
    rmSync(join(app, 'storage'), { recursive: true, force: true });
    // What `bespoke build` leaves: the injection lists and the discovery manifest (discovering would parse .d.ts files with oxc).
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

  it('derives the lists of a module changed after the build — on every start, with the compile cache warm — and says so once (E138)', async () => {
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

  it('analyses what bespoke build never saw — a missing file, a module not in it — instead of failing (E138)', async () => {
    rmSync(join(app, '.bespoke/injections.json'), { force: true });
    const { output } = await startOnce();
    expect(output).toContain('greeter: SystemClock');
    expect(output).toContain('Build artifacts are missing (.bespoke/injections.json): the injection lists of 1 file (services/Greeter.ts)');
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
 * Where NODE_ENV comes from (E170): the process's, else the app's `.env` — what a developer's machine has (`NODE_ENV=development`
 * from `.env.example`). A copy of the blank app with a `.env` of its own; the commands run without a NODE_ENV of the process.
 */
describe('NODE_ENV from the app’s .env (E170)', () => {
  let app: string;
  const blank = join(repo, 'apps/blank-app');
  const config = (dir: string) => `APP_NAME=Blank\nAPP_URL=http://localhost\nAPP_KEY=base64:${Buffer.alloc(32, 5).toString('base64')}\nDB_DATABASE=${join(dir, 'db.sqlite')}\nMAIL_MAILER=array\n`;
  const inApp = (args: string[], env: Record<string, string> = {}) => bespoke(app, args, { NODE_ENV: '', ...env });

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-dotenv-')));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.bespoke|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('a developer migrates without --force: NODE_ENV=development from .env, table types written, the worker warns', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=development\n${config(app)}`);
    rmSync(join(app, 'bootstrap/database.d.ts'), { force: true });
    const migrate = inApp(['migrate']);
    expect(migrate.stdout).toContain('Environment: development (from .env)\n');
    expect(migrate.stdout).toContain('Wrote bootstrap/database.d.ts');
    expect(migrate.code).toBe(0);
    expect(existsSync(join(app, 'bootstrap/database.d.ts'))).toBe(true);
    // A production command as development because of .env: said, not refused.
    const worker = inApp(['queue:work', '--stop-when-empty']);
    expect(worker.code).toBe(0);
    expect(`${worker.stdout}${worker.stderr}`).toContain('NODE_ENV=development comes from .env, not from the environment: bespoke queue:work runs with the development tools');
    expect(worker.stdout).toContain('— in development (from .env)');
  }, 30_000);

  it('the process NODE_ENV wins over .env', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=development\n${config(app)}`);
    const staging = inApp(['migrate'], { NODE_ENV: 'staging' });
    expect(staging.code).toBe(1);
    expect(staging.stdout).toContain('Environment: staging (protected)\n');
    expect(staging.stderr).toContain('Pass --force to migrate');
  }, 30_000);

  it('ignores NODE_ENV in .env.{NODE_ENV} — and without NODE_ENV anywhere the app is protected', () => {
    writeFileSync(join(app, '.env'), `NODE_ENV=staging\n${config(app)}`);
    writeFileSync(join(app, '.env.staging'), 'NODE_ENV=development\n');
    try {
      const staging = inApp(['migrate']);
      expect(staging.stderr).toContain('NODE_ENV in .env.staging is ignored: .env.staging is chosen by NODE_ENV and cannot set it');
      expect(staging.stdout).toContain('Environment: staging (protected, from .env)\n');
      expect(staging.code).toBe(1);
    } finally {
      rmSync(join(app, '.env.staging'));
    }
    writeFileSync(join(app, '.env'), config(app));
    const unset = inApp(['migrate']);
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('The application is protected (unset NODE_ENV (protected, like production)). Pass --force to migrate');
  }, 30_000);
});

/** The fixture's `services/Greeter.ts`, whose constructor takes `parameters` (a `Clock`, maybe a `Redactor`). */
function greeter(parameters: string[]): string {
  return [
    "import { Clock, Redactor } from '@bespokecore/core';",
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
