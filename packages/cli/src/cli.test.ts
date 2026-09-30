import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(repo, 'packages/cli/bin/bespoke.js');
const webApp = join(repo, 'apps/web-app');
const tsc = join(repo, 'node_modules/.bin/tsc');

function bespoke(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { BESPOKE_CHILD: _child, ...parent } = process.env; // the launcher must re-exec, not think it is the child
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
    expect(stdout).not.toMatch(/^ {2}serve\b/m); // internal
  });

  it('lists routes through a command that gets the Router injected', () => {
    const { code, stdout } = bespoke(webApp, ['route:list']);
    expect(code).toBe(0);
    expect(stdout).toMatch(
      /GET\s+\/users\/:id\s+user-profile\.show\s+web\s+SecurityHeaders, EncryptCookies, StartSession, Authenticate\s+ShowUserProfileController/,
    );
    expect(stdout).toMatch(/GET\s+\/api\/users\s+api\.users\.index\s+api\s+SecurityHeaders\s+ListUsersController/);
    expect(stdout).toContain('7 routes');
  });

  it('prints configuration errors without Node internals and exits with 1', () => {
    const { code, stderr } = bespoke(webApp, ['route:list'], { APP_NAME: '', APP_URL: 'localhost' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ Invalid configuration — the application cannot start:\n {2}• app: APP_NAME/);
    expect(stderr).not.toMatch(/triggerUncaughtException|node:internal/);
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
    for (const pkg of ['core', 'http', 'router']) link(`@bespokecore/${pkg}`, join(repo, 'packages', pkg));
    for (const pkg of ['react', '@types/react']) link(pkg, realpathSync(join(webApp, 'node_modules', pkg)));
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

    const controller = readFileSync(join(app, 'modules/billing/controllers/ShowInvoiceController.ts'), 'utf8');
    expect(controller).toContain("return this.view('billing/ShowInvoice', {});");
    expect(readFileSync(join(app, 'modules/billing/events/InvoicePaid.ts'), 'utf8')).toContain('readonly #event = true;');

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
