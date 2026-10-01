import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const output = {
    success: (line: string) => lines.push(`✓ ${line}`),
    error: (line: string) => lines.push(`✗ ${line}`),
    line: (line = '') => lines.push(line),
  };
  return { input: { root, args: [], options, output } as never, lines };
}

describe('make:auth', () => {
  it('writes the module, registers it, and reports what the app still needs', () => {
    const root = blankApp();
    const { input, lines } = fakeInput(root);
    expect(new MakeAuthCommand().handle(input)).toBe(0);
    expect(existsSync(join(root, 'modules/auth/controllers/LoginController.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules/auth/migrations/0001_01_01_000000_create_users_table.ts'))).toBe(true);
    const app = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    expect(app).toContain("import auth from '#modules/auth';");
    expect(app).toMatch(/modules: \[auth\]/);
    expect(lines[0]).toMatch(/^✓ Created modules\/auth \(\d+ files\)$/);
    expect(lines).toContain('✓ Registered the module in bootstrap/app.ts');
  });

  it('refuses to overwrite an existing module unless forced — the module belongs to the app', () => {
    const root = blankApp();
    new MakeAuthCommand().handle(fakeInput(root).input);
    writeFileSync(join(root, 'modules/auth/routes.ts'), '// changed by the app\n');
    const { input, lines } = fakeInput(root);
    expect(new MakeAuthCommand().handle(input)).toBe(1);
    expect(lines).toEqual(['✗ modules/auth already exists. It is yours now — pass --force to overwrite it with the templates.']);
    expect(readFileSync(join(root, 'modules/auth/routes.ts'), 'utf8')).toBe('// changed by the app\n');
    expect(new MakeAuthCommand().handle(fakeInput(root, { force: true }).input)).toBe(0);
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').match(/#modules\/auth/g)).toHaveLength(1); // registered once
  });

  it('knows its adapters', () => {
    const { input, lines } = fakeInput(blankApp(), { adapter: 'vue' });
    expect(new MakeAuthCommand().handle(input)).toBe(1);
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
    },
    300_000,
  );
});
