import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { main } from './main.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');

const SKIPPED = new Set(['node_modules', '.marmeon', 'storage']);

/** Every file of the app but its installed packages (links into the workspace) and what a run writes (`.marmeon/`, the app's `storage/`), by path, with a hash of what it holds (a link by its target). */
function snapshot(root: string, dir = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (dir === '' ? SKIPPED.has(entry.name) : entry.name === 'node_modules') continue;
    if (entry.isDirectory()) for (const [file, hash] of snapshot(root, path)) files.set(file, hash);
    else files.set(path, createHash('sha256').update(entry.isSymbolicLink() ? `link:${readlinkSync(join(root, path))}` : readFileSync(join(root, path))).digest('hex'));
  }
  return files;
}

/**
 * The starter kit with `make:oauth`, as an app developer gets it: the generator adds the module and changes nothing else; then the
 * app places the islands as docs/oauth.md shows, writes the migration with `make:social-accounts-table`, and `migrate`, the route
 * types, the table types, the type check, the lint preset (with module boundaries) and the module's own tests pass. The framework
 * comes from the workspace, and `@marmeon/oauth` is linked into the app like a dependency (`workspace:*`). On Postgres too when
 * `pnpm test:pgsql` runs: only the nested Vitest sees the `DB_*` variables.
 */
it(
  'the starter kit with make:oauth: only new files and the module entry, then migrate, typecheck, lint and the oauth tests pass',
  async () => {
    const cwd = tempDir('marmeon-kit-oauth-');
    const stderr = new PassThrough();
    let said = '';
    stderr.on('data', (chunk: Buffer) => (said += chunk));
    const code = await main({
      argv: ['kit', '--no-install', '--no-git'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd,
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
      stdout: Object.assign(new PassThrough(), { isTTY: false }),
      stderr,
    });
    expect(code, said).toBe(0);
    const root = join(cwd, 'kit');
    // The blank app's installed packages, as in kit.test.ts, but `@marmeon` is a directory of its own: it also links the package under test,
    // and a link into the blank app's directory would write there.
    mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
    for (const entry of readdirSync(join(blank, 'node_modules'))) {
      if (entry === '@marmeon' || (entry.startsWith('.') && entry !== '.bin')) continue;
      symlinkSync(join(blank, 'node_modules', entry), join(root, 'node_modules', entry));
    }
    for (const entry of readdirSync(join(blank, 'node_modules/@marmeon'))) symlinkSync(join(blank, 'node_modules/@marmeon', entry), join(root, 'node_modules/@marmeon', entry));
    symlinkSync(join(repo, 'packages/oauth'), join(root, 'node_modules/@marmeon/oauth'), 'dir');
    symlinkSync(join(repo, 'packages/vite/node_modules/@fontsource-variable'), join(root, 'node_modules/@fontsource-variable'), 'dir');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    manifest.dependencies['@marmeon/oauth'] = 'workspace:*';
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV') delete env[key];
    const run = (command: string, args: string[], extra: Record<string, string> = {}, base = env) => {
      const result = spawnSync(command, args, { cwd: root, env: { ...base, NO_COLOR: '1', FORCE_COLOR: '0', ...extra }, encoding: 'utf8', timeout: 240_000 });
      return { code: result.status, out: stripVTControlCharacters(`${result.stdout}${result.stderr}`) };
    };
    // The CLI steps stay on the app's SQLite file; under `pnpm test:pgsql` only the generated tests use Postgres (their own worker databases).
    const { DB_DRIVER: _connection, DB_URL: _url, ...sqliteEnv } = env;
    const marmeon = (...args: string[]) => run(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), ...args], {}, sqliteEnv);

    expect(marmeon('make:auth').code).toBe(0);
    const before = snapshot(root);

    const generated = marmeon('make:oauth');
    expect(generated.out).toContain('Created modules/oauth');
    expect(generated.code, generated.out).toBe(0);
    // No package to install and no password migration to copy: the packages are linked, and the kit has the migration from make:auth.
    expect(generated.out).not.toMatch(/Install what|And what|Production needs/);
    expect(generated.out).not.toContain('make_users_password_optional');
    expect(generated.out).toContain('marmeon make:social-accounts-table');
    // Only the module, its entry in the app, the record of what was written and the route types the generator regenerates changed or appeared.
    const after = snapshot(root);
    const touched = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
    const allowed = (path: string) => path.startsWith('modules/oauth/') || ['bootstrap/app.ts', 'marmeon-stubs.json', 'bootstrap/routes.ts'].includes(path);
    expect(touched.filter((path) => !allowed(path))).toEqual([]);
    // Nothing the module brought was there before: the files of the module are all new.
    expect(touched.filter((path) => path.startsWith('modules/oauth/') && before.has(path))).toEqual([]);
    expect(touched).toContain('bootstrap/app.ts');
    expect(touched).toContain('modules/oauth/routes.ts');
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain('oauth');
    expect(readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')).toContain("'oauth.sign-in'");

    // The app developer places the islands (docs/oauth.md#placing-the-components): the buttons on the sign-in page, the accounts on a
    // settings page, the confirming buttons on the confirmation page.
    const place = (view: string, route: string, after: string) => {
      const file = join(root, 'modules/auth/views', view);
      const source = readFileSync(file, 'utf8');
      const imported = source.replace(/import \{ ([^}]*) \} from '@marmeon\/react';/, (_, names: string) => `import { ${names}, Island } from '@marmeon/react';`);
      expect(imported, `${view} imports from @marmeon/react`).not.toBe(source);
      expect(imported, `${view} has ${after}`).toContain(after);
      writeFileSync(file, imported.replace(after, `${after}\n<Island route="${route}" fallback={<p aria-busy="true">…</p>} />`));
    };
    place('Login.tsx', 'oauth.sign-in', '        </form>');
    place('Security.tsx', 'oauth.accounts', '<Head title={t(\'security.title\')} />');
    place('ConfirmPassword.tsx', 'oauth.confirm-options', '</form>');

    const table = marmeon('make:social-accounts-table');
    expect(table.code, table.out).toBe(0);
    const written = readdirSync(join(root, 'modules/system/migrations')).filter((file) => file.endsWith('_create_social_accounts_table.ts'));
    expect(written).toHaveLength(1);
    const migrated = marmeon('migrate');
    expect(migrated.out).toContain('create_social_accounts_table');
    expect(migrated.code, migrated.out).toBe(0);
    expect(readFileSync(join(root, 'bootstrap/database.d.ts'), 'utf8')).toMatch(/social_accounts: \{[^}]*access_token: Secret<string \| null>;/);
    expect(marmeon('route:types').code).toBe(0);
    expect(marmeon('route:types', '--check').code).toBe(0);
    const types = marmeon('db:types', '--check');
    expect(types.code, types.out).toBe(0);

    const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', root]);
    expect(typecheck.out).toBe('');
    expect(typecheck.code).toBe(0);

    const linted = (...paths: string[]) => {
      const result = run(join(root, 'node_modules/.bin/oxlint'), ['--deny-warnings', ...paths]);
      expect(result.code, result.out).toBe(0);
    };
    linted();
    expect(marmeon('make:lint-config', '--boundaries', '--force').code).toBe(0);
    linted('modules/auth', 'modules/oauth', 'modules/system');

    const tests = run(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'native', '--reporter=verbose', '--testTimeout=30000', 'modules/oauth'], { NODE_OPTIONS: '--conditions=@marmeon/source', NODE_ENV: 'test' });
    const failed = tests.out.split('\n').filter((line) => /^\s*(×|FAIL)/.test(line)).join('\n');
    expect(tests.out, `the module's tests failed:\n${failed}`).toMatch(/Test Files\s+3 passed \(3\)/);
    expect(tests.out, `the module's tests failed:\n${failed}`).toMatch(/Tests\s+75 passed \(75\)/);
    // The tests of each `describe`: a test added to a stub test changes its count here (75 in all).
    const ran = (file: string, describe: string) => tests.out.match(new RegExp(`✓ modules/oauth/${file}\\.test\\.ts > ${describe.replace(/[()]/g, '\\$&')} > `, 'g'))?.length ?? 0;
    expect({
      'sign-in': [ran('sign-in', 'signing in at a provider'), ran('sign-in', 'with OAUTH_REGISTRATION=false')],
      confirm: [ran('confirm', 'confirming with a provider')],
      'connected-accounts': [
        ran('connected-accounts', 'the connected accounts'),
        ran('connected-accounts', 'with a short confirmation window'),
        ran('connected-accounts', 'the mail about a linked account'),
        ran('connected-accounts', 'the listener of the linked account'),
        ran('connected-accounts', 'the mail about a linked account, with open registration'),
        ran('connected-accounts', 'starting a link'),
      ],
    }).toEqual({ 'sign-in': [25, 1], confirm: [13], 'connected-accounts': [22, 1, 4, 7, 1, 1] });
    expect(tests.code).toBe(0);
  },
  600_000,
);
