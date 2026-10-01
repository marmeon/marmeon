import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MakeAuthCommand } from './make-auth.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');
const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the blank app (its installed packages linked in), outside the workspace. */
function blankApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bespoke-make-auth-'));
  temporary.push(dir);
  cpSync(blank, dir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|\.bespoke|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !source.endsWith('.env'),
  });
  symlinkSync(join(blank, 'node_modules'), join(dir, 'node_modules'), 'dir');
  mkdirSync(join(dir, 'storage'), { recursive: true });
  // Outside the workspace: the shared compiler settings and Node's types by absolute path.
  const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')) as { extends: string; compilerOptions: Record<string, unknown> };
  tsconfig.extends = join(repo, 'tsconfig.base.json');
  tsconfig.compilerOptions.typeRoots = [join(repo, 'node_modules/@types'), join(dir, 'node_modules')];
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  writeFileSync(join(dir, '.env'), readFileSync(join(blank, '.env.test'), 'utf8').replace('DB_DATABASE=:memory:', 'DB_DATABASE=storage/database.sqlite'));
  return dir;
}

function fakeInput(root: string, options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const spawned: string[][] = [];
  const output = {
    success: (line: string) => lines.push(`✓ ${line}`),
    error: (line: string) => lines.push(`✗ ${line}`),
    line: (line = '') => lines.push(line),
  };
  const spawn = async (...args: string[]) => (spawned.push(args), 0);
  return { input: { root, args: [], options, output, spawn } as never, lines, spawned };
}

describe('make:auth', () => {
  it('writes the module, registers it, generates its route types, and reports what the app still needs', async () => {
    const root = blankApp();
    const { input, lines, spawned } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    // In a fresh process: this one booted without the module.
    expect(spawned).toEqual([['route:types']]);
    expect(existsSync(join(root, 'modules/auth/controllers/LoginController.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules/auth/migrations/0001_01_01_000000_create_users_table.ts'))).toBe(true);
    const app = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    expect(app).toContain("import auth from '#modules/auth';");
    expect(app).toMatch(/modules: \[auth\]/);
    expect(lines[0]).toMatch(/^✓ Created modules\/auth \(\d+ files\)$/);
    expect(lines).toContain('✓ Registered the module in bootstrap/app.ts');
  });

  it('refuses to overwrite an existing module unless forced — the module belongs to the app', async () => {
    const root = blankApp();
    await new MakeAuthCommand().handle(fakeInput(root).input);
    writeFileSync(join(root, 'modules/auth/routes.ts'), '// changed by the app\n');
    const { input, lines } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(1);
    expect(lines).toEqual(['✗ modules/auth already exists. It is yours now — pass --force to overwrite it with the templates.']);
    expect(readFileSync(join(root, 'modules/auth/routes.ts'), 'utf8')).toBe('// changed by the app\n');
    expect(await new MakeAuthCommand().handle(fakeInput(root, { force: true }).input)).toBe(0);
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').match(/#modules\/auth/g)).toHaveLength(1); // registered once
  });

  it('knows its adapters', async () => {
    const { input, lines } = fakeInput(blankApp(), { adapter: 'vue' });
    expect(await new MakeAuthCommand().handle(input)).toBe(1);
    expect(lines[0]).toBe('✗ There are no auth templates for the UI adapter "vue". Known: react.');
  });

  /**
   * The acceptance of wave 4 (E30): a new app gets a complete auth area whose own tests pass — generated,
   * migrated, type-checked and tested as a user would. On Postgres too when `pnpm test:pgsql` runs.
   */
  it(
    'gives a new app a working auth area: its generated tests pass',
    () => {
      const root = blankApp();
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST') delete env[key];
      const run = (command: string, args: string[], extra: Record<string, string> = {}, base = env) => {
        const result = spawnSync(command, args, { cwd: root, env: { ...base, ...extra }, encoding: 'utf8', timeout: 240_000 });
        return { code: result.status, out: `${result.stdout}${result.stderr}` };
      };
      // The CLI steps stay on the app's SQLite file; under `pnpm test:pgsql` only the generated tests use Postgres
      // (their own worker databases) — never the shared one.
      const { DB_CONNECTION: _connection, DB_URL: _url, ...sqliteEnv } = env;
      const bespoke = (...args: string[]) => run(process.execPath, [join(repo, 'packages/cli/bin/bespoke.js'), ...args], { NODE_ENV: 'development' }, sqliteEnv);

      expect(bespoke('discover').code).toBe(0);
      const generated = bespoke('make:auth');
      expect(generated.out).toContain('Created modules/auth');
      expect(generated.code).toBe(0);
      // make:auth ran `bespoke route:types`: the module's routes, controllers and views are typed (W5.2).
      const routeTypes = readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8');
      expect(generated.out).toContain('Wrote bootstrap/routes.ts');
      expect(routeTypes).toContain("'auth.login.store': { method: 'post'; path: '/login'; controller: typeof LoginController };");
      expect(routeTypes).toContain("'api.user': { method: 'get'; path: '/api/user'; browser: false };");
      expect(routeTypes).toContain("'auth/Dashboard': true;");
      expect(bespoke('route:types', '--check').code).toBe(0);
      const migrated = bespoke('migrate');
      expect(migrated.out).toContain('create_personal_access_tokens_table');
      expect(migrated.code).toBe(0);
      expect(readFileSync(join(root, 'bootstrap/database.d.ts'), 'utf8')).toContain('password: Secret<string>;');

      const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', root]);
      expect(typecheck.out).toBe('');
      expect(typecheck.code).toBe(0);

      const tests = run(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'native'], { NODE_OPTIONS: '--conditions=@bespokecore/source', NODE_ENV: 'test' });
      expect(tests.out).toMatch(/Tests\s+\d+ passed \(\d+\)/);
      expect(tests.out).not.toMatch(/failed/);
      expect(tests.code).toBe(0);

      // A stale bootstrap/routes.ts fails the CI check.
      const stalled = routeTypes.replace(/^ {4}'dashboard': .*\n/m, '');
      expect(stalled).not.toBe(routeTypes);
      writeFileSync(join(root, 'bootstrap/routes.ts'), stalled);
      const stale = bespoke('route:types', '--check');
      expect(stale.out).toContain('bootstrap/routes.ts is out of date — run: bespoke route:types');
      expect(stale.code).toBe(1);

      // The build regenerates it, and the client bundle carries only the routes its code names (E57): no API route, no
      // `.internal()` route, none that only the server redirects to — their names and patterns stay on the server.
      const built = bespoke('build');
      expect(built.out).toContain('Built dist/client and dist/server');
      expect(built.code).toBe(0);
      expect(readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')).toContain("'auth.verification.verify': { method: 'get'; path: '/email/verify/:id/:hash'; controller: typeof VerifyEmailController; browser: false };");
      const client = readdirSync(join(root, 'dist/client'), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(root, 'dist/client', file), 'utf8'))
        .join('\n');
      expect(client).toContain('auth.login.store');
      expect(client).toContain('/dashboard');
      expect(readFileSync(join(root, '.bespoke/routes.json'), 'utf8')).toContain('"auth.password.reset"'); // the browser may learn it …
      for (const serverOnly of ['auth.password.reset', 'auth.password.confirm', 'auth.verification.notice']) {
        expect(client).not.toMatch(new RegExp(`[\`"']${serverOnly.replaceAll('.', '\\.')}[\`"']`)); // … but no view names it
      }
      expect(client).not.toContain('auth.verification.verify');
      expect(client).not.toContain('/email/verify/:id/:hash');
      expect(client).not.toContain('api.user');
      expect(client).not.toMatch(/["'`]\/api\/user["'`]/); // the page text mentions /api/users — the pattern itself must be absent
    },
    300_000,
  );
});
