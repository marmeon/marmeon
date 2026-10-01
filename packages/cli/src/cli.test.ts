import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      /GET\s+\/users\/:user\s+user-profile\.show\s+web\s+SecurityHeaders, EncryptCookies, ClearClientHistory, StartSession, NoStoreWhenSignedIn, .*ShareAppProps, authenticate\s+ShowUserProfileController/,
    );
    expect(stdout).toMatch(/GET\s+\/api\/users\s+api\.users\.index\s+api\s+SecurityHeaders, authenticate:api, abilities:users:read\s+ListUsersController/);
    expect(stdout).toMatch(/\n\d+ routes\n$/); // the count grows with the app
  });

  it('prints configuration errors without Node internals and exits with 1', () => {
    const { code, stderr } = bespoke(webApp, ['route:list'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ Invalid configuration — the application cannot start:\n {2}• app: APP_NAME/);
    expect(stderr).not.toMatch(/triggerUncaughtException|node:internal/);
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
    // …then regenerates the table types (already committed, so unchanged).
    expect(migrate.stdout).toMatch(/ℹ bootstrap\/database\.d\.ts is up to date\.\n$/);
    expect(bespoke(webApp, ['migrate:fresh'], { ...memory, NODE_ENV: 'production' }).stderr).toContain('Pass --force to drop every table.');
  });

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
    for (const pkg of ['core', 'http', 'router', 'database']) link(`@bespokecore/${pkg}`, join(repo, 'packages', pkg));
    for (const pkg of ['react', '@types/react', 'valibot']) link(pkg, realpathSync(join(webApp, 'node_modules', pkg)));
    link('@types/node', realpathSync(join(repo, 'node_modules/@types/node'))); // the framework sources need them
    writeFileSync(
      join(app, 'tsconfig.json'),
      JSON.stringify({
        extends: join(repo, 'tsconfig.base.json'),
        compilerOptions: { noEmit: true, jsx: 'react-jsx', lib: ['ES2025', 'ESNext.TypedArrays', 'DOM'], types: ['node'] },
        include: ['modules'],
      }),
    );
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('scaffolds a module, controller with view, event, listener and middleware', () => {
    expect(bespoke(app, ['make:module', 'billing']).stdout).toContain("import billing from '#modules/billing';");
    expect(bespoke(app, ['make:controller', 'ShowInvoice', '--module=billing', '--view']).code).toBe(0);
    expect(bespoke(app, ['make:event', 'InvoicePaid', '-m', 'billing']).code).toBe(0);
    expect(bespoke(app, ['make:listener', 'SendReceipt', '--event=InvoicePaid', '--module=billing']).stdout).toContain(
      'listeners: [listen(InvoicePaid, SendReceipt)]',
    );
    expect(bespoke(app, ['make:middleware', 'EnsureCustomer', '--module=billing']).code).toBe(0);
    expect(bespoke(app, ['make:controller', 'UpdateInvoice', '--module=billing', '--request']).code).toBe(0);
    expect(bespoke(app, ['make:migration', 'create_invoices_table', '--module=billing']).stdout).toContain(
      "migrations: new URL('./migrations/', import.meta.url)",
    );
    expect(bespoke(app, ['make:migration', 'add_due_date_to_invoices_table', '--module=billing']).code).toBe(0);
    expect(bespoke(app, ['make:migration', 'backfill_totals', '--module=billing']).code).toBe(0);
    expect(bespoke(app, ['make:migration', 'CreateInvoices', '--module=billing']).stderr).toContain('Pass a snake_case name');

    const controller = readFileSync(join(app, 'modules/billing/controllers/ShowInvoiceController.ts'), 'utf8');
    expect(controller).toContain("return this.view('billing/ShowInvoice', {});");
    expect(readFileSync(join(app, 'modules/billing/events/InvoicePaid.ts'), 'utf8')).toContain('readonly #event = true;');
    const withRequest = readFileSync(join(app, 'modules/billing/controllers/UpdateInvoiceController.ts'), 'utf8');
    expect(withRequest).toContain('export const UpdateInvoiceRequest = defineRequest({');
    expect(withRequest).toContain('static request = UpdateInvoiceRequest;');
    expect(withRequest).toContain('handle(ctx: ContextOf<typeof UpdateInvoiceRequest>) {');

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
  });

  it('refuses to overwrite and explains missing modules', () => {
    bespoke(app, ['make:module', 'shop']);
    const again = bespoke(app, ['make:module', 'shop']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('modules/shop/index.ts already exists (use --force to overwrite)');

    const missing = bespoke(app, ['make:controller', 'ShowCart', '--module=cart']);
    expect(missing.stderr).toContain('Module "cart" does not exist. Create it first: bespoke make:module cart');
  });

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
