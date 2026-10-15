import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatAccessProblems, Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { AUTH_STYLES_IMPORT, MakeAuthCommand, NEEDED, NEEDED_FOR_TESTS, STUBS } from './make-auth.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');

/** A copy of the blank app (its installed packages linked in), outside the workspace. */
function blankApp(): string {
  const dir = tempDir('marmeon-make-auth-');
  cpSync(blank, dir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !source.endsWith('.env'),
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
    warn: (line: string) => lines.push(`! ${line}`),
    error: (line: string) => lines.push(`✗ ${line}`),
    line: (line = '') => lines.push(line),
  };
  const spawn = async (...args: string[]) => (spawned.push(args), 0);
  return { input: { root, args: [], options, output, spawn } as never, lines, spawned };
}

// Each test runs make:auth, which spawns a child process: slow on a busy machine.
describe('make:auth', { timeout: 30_000 }, () => {
  it('writes the module, registers it, generates its route types, and reports what the app still needs', async () => {
    const root = blankApp();
    const { input, lines, spawned } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    // In a fresh process: this one booted without the module.
    expect(spawned).toEqual([['route:types']]);
    expect(existsSync(join(root, 'modules/auth/controllers/LoginController.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules/auth/migrations/0001_01_01_000000_create_users_table.ts'))).toBe(true);
    // Two-factor authentication: the pages, and the tables of its factor and recovery codes (the rest of the framework is bound in the provider).
    expect(existsSync(join(root, 'modules/auth/views/TwoFactorChallenge.tsx'))).toBe(true);
    expect(readFileSync(join(root, 'modules/auth/migrations/0001_01_01_000004_create_two_factor_tables.ts'), 'utf8')).toContain("foreignId('user_id').constrained().cascadeOnDelete()");
    expect(existsSync(join(root, 'modules/auth/commands/ResetTwoFactorCommand.ts'))).toBe(true);
    // Passkeys: the page and the browser code, and the table (a foreign key that cascades, and the mark of a suspended passkey).
    expect(existsSync(join(root, 'modules/auth/views/Passkeys.tsx'))).toBe(true);
    expect(existsSync(join(root, 'modules/auth/passkeys.ts'))).toBe(true);
    const passkeyTable = readFileSync(join(root, 'modules/auth/migrations/0001_01_01_000005_create_passkeys_table.ts'), 'utf8');
    expect(passkeyTable).toContain("foreignId('user_id').constrained().cascadeOnDelete()");
    expect(passkeyTable).toContain('suspended_at');
    expect(readFileSync(join(root, 'modules/auth/AuthServiceProvider.ts'), 'utf8')).toContain('combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore))');
    // The sign-ins list: opt-in by the binding of its store, the table of it, and the route that ends one.
    expect(readFileSync(join(root, 'modules/auth/AuthServiceProvider.ts'), 'utf8')).toContain('container.singleton(SignInStore, DatabaseSignIns)');
    expect(readFileSync(join(root, 'modules/auth/migrations/0001_01_01_000006_create_sign_ins_table.ts'), 'utf8')).toContain("foreignId('user_id').constrained().cascadeOnDelete()");
    expect(existsSync(join(root, 'modules/auth/controllers/EndSignInController.ts'))).toBe(true);
    const app = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    expect(app).toContain("import auth from '#modules/auth';");
    expect(app).toMatch(/modules: \[auth, system\]/);
    expect(lines[0]).toMatch(/^✓ Created modules\/auth \(\d+ files\)$/);
    expect(lines).toContain('✓ Registered the module in bootstrap/app.ts');
    // Its look: a stylesheet the client entry imports — once, after the framework's.
    const client = readFileSync(join(root, 'bootstrap/client.tsx'), 'utf8');
    expect(client.match(/modules\/auth\/auth\.css/g)).toHaveLength(1);
    expect(client.indexOf(AUTH_STYLES_IMPORT)).toBeGreaterThan(client.indexOf("import '@marmeon/react/styles.css';"));
    expect(lines).toContain('✓ Imported its styles (modules/auth/auth.css) in bootstrap/client.tsx');
    // The blank app has its lint preset, the devtools and a Content-Security-Policy: none is named.
    expect(lines.filter((line) => line.startsWith('Lint:') || line.startsWith('Devtools') || line.startsWith('Content-Security-Policy'))).toEqual([]);
    // The auth mails' queue, and the worker production needs for it.
    expect(lines).toContain('Its mails go through the queue, on its "mail" queue: a jobs table (marmeon make:queue-table, once) and a worker (marmeon dev starts one; in production: marmeon queue:work, which takes every queue).');
    expect(lines).toContain('Accounts whose address was never confirmed stay until your app decides: marmeon auth:prune-unverified deletes them after AUTH_UNVERIFIED_DAYS — its line in modules/auth/schedule.ts is commented out.');
  });

  it('writes no check that always says yes: a controller types its context, and the routes decide', async () => {
    const root = blankApp();
    expect(await new MakeAuthCommand().handle(fakeInput(root).input)).toBe(0);
    const written = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? written(join(directory, entry.name)) : [join(directory, entry.name)]));
    for (const file of written(join(root, 'modules/auth')).filter((path) => /\.tsx?$/.test(path))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\) => true\b/);
    }
    const routes = readFileSync(join(root, 'modules/auth/routes.ts'), 'utf8');
    expect(routes).toMatch(/const guests = Route\.middleware\(guest\([^)]*\)\)\.authorize\(everyone\);/);
    expect(routes).toContain('const account = Route.middleware(authenticate()).authorize(everyone);');
    expect(readFileSync(join(root, 'modules/auth/controllers/RenamePasskeyController.ts'), 'utf8')).toContain('ContextOf<typeof RenamePasskeyRequest> & Authenticated');
    // Every route of the generated module, the API one included, says who may call it.
    const router = new Router();
    for (const file of ['routes.ts', 'api-routes.ts']) {
      const loaded = (await import(pathToFileURL(join(root, 'modules/auth', file)).href)) as { default: Parameters<Router['load']>[0] };
      router.load(loaded.default);
    }
    expect(router.accessProblems().length, formatAccessProblems(router.accessProblems())).toBe(0);
  });

  it('registers in the real modules list — a commented-out one before the call is left alone', async () => {
    const root = blankApp();
    const bootstrap = join(root, 'bootstrap/app.ts');
    const source = readFileSync(bootstrap, 'utf8');
    writeFileSync(bootstrap, source.replace('export default defineApplication', '// modules: [legacy]\nexport default defineApplication'));
    const { input, lines } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    const app = readFileSync(bootstrap, 'utf8');
    expect(app).toContain('// modules: [legacy]\n');
    expect(app).toMatch(/modules: \[auth, system\]/);
    expect(lines).toContain('✓ Registered the module in bootstrap/app.ts');
  });

  it('leaves bootstrap/app.ts as it is when the modules list is not written out there, and says what to add', async () => {
    const root = blankApp();
    const bootstrap = join(root, 'bootstrap/app.ts');
    const source = readFileSync(bootstrap, 'utf8').replace('modules: [system]', 'modules: appModules');
    writeFileSync(bootstrap, source);
    const { input, lines } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    expect(readFileSync(bootstrap, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered — '))).toBe(true);
    expect(lines).toContain('Register the module in bootstrap/app.ts:');
    expect(lines).toContain("  import auth from '#modules/auth';");
  });

  it('counts a hand-written import of the module as registered even when the modules list is not written out', async () => {
    const root = blankApp();
    const bootstrap = join(root, 'bootstrap/app.ts');
    const source = readFileSync(bootstrap, 'utf8').replace('modules: [system]', 'modules: appModules').replace("import system from '#modules/system';", "import system from '#modules/system';\nimport auth from '#modules/auth';");
    writeFileSync(bootstrap, source);
    const { input, lines, spawned } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    expect(readFileSync(bootstrap, 'utf8')).toBe(source);
    expect(lines.some((line) => line.includes('Not registered'))).toBe(false);
    expect(spawned).toEqual([['route:types']]);
  });

  it('names the lint preset, the devtools and the CSP only while the app has none of them (they belong to the app)', async () => {
    const root = blankApp();
    rmSync(join(root, '.oxlintrc.json'));
    const bootstrap = join(root, 'bootstrap/app.ts');
    writeFileSync(bootstrap, readFileSync(bootstrap, 'utf8').replace(', contentSecurityPolicy()', ''));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    delete pkg.devDependencies['@marmeon/devtools'];
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const without = fakeInput(root);
    expect(await new MakeAuthCommand().handle(without.input)).toBe(0);
    expect(without.lines).toContain("Lint: marmeon make:lint-config writes the app's preset (views import controllers only with import type).");
    expect(without.lines).toContain('Devtools for marmeon dev (requests, queries, jobs, mails at /_marmeon/devtools): pnpm add -D @marmeon/devtools');
    expect(without.lines).toContain("Content-Security-Policy: add contentSecurityPolicy() of @marmeon/http to the app's global middleware (a nonce per page).");
    writeFileSync(join(root, '.oxlintrc.json'), '{}\n');
    pkg.devDependencies['@marmeon/devtools'] = 'workspace:*';
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const both = fakeInput(root, { force: true });
    expect(await new MakeAuthCommand().handle(both.input)).toBe(0);
    expect(both.lines.filter((line) => line.startsWith('Lint:') || line.startsWith('Devtools'))).toEqual([]);
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
    expect(readFileSync(join(root, 'bootstrap/client.tsx'), 'utf8').match(/modules\/auth\/auth\.css/g)).toHaveLength(1); // its styles too
  });

  it('names every package its templates import — the module\'s in NEEDED, its tests\' in NEEDED_FOR_TESTS', () => {
    const imported = (test: boolean) => {
      const names = new Set<string>();
      for (const file of readdirSync(STUBS, { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) !== test) continue;
        for (const [, specifier] of readFileSync(join(STUBS, file), 'utf8').matchAll(/(?:from|import)\s+'([^'.#][^']*)'/g)) {
          if (specifier!.startsWith('node:')) continue;
          const parts = specifier!.split('/');
          names.add(specifier!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
        }
      }
      return [...names].sort();
    };
    const module = imported(false);
    expect(module).toContain('@marmeon/i18n');
    expect(module.filter((name) => !NEEDED.includes(name))).toEqual([]);
    expect(imported(true).filter((name) => !NEEDED.includes(name) && !NEEDED_FOR_TESTS.includes(name))).toEqual([]);
  });

  it('reports what the app lacks — the module\'s packages and its tests\'', async () => {
    const root = blankApp();
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    delete pkg.dependencies['@marmeon/i18n'];
    delete pkg.devDependencies['@marmeon/testing'];
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const { input, lines, spawned } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    expect(lines).toContain('Install what the module uses: pnpm add @marmeon/i18n');
    expect(lines).toContain('And what its tests use: pnpm add -D @marmeon/testing');
    // Without the module's packages the route types would not load: not generated now.
    expect(spawned).toEqual([]);
  });

  it('names what the module runs with in production but the app has as a dev dependency — marmeon', async () => {
    const root = blankApp();
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    pkg.devDependencies['marmeon'] = pkg.dependencies['marmeon']!;
    delete pkg.dependencies['marmeon'];
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const { input, lines } = fakeInput(root);
    expect(await new MakeAuthCommand().handle(input)).toBe(0);
    expect(lines).toContain('Production needs these as dependencies, not dev dependencies: pnpm add marmeon');
    expect(lines.filter((line) => line.startsWith('Install what the module uses'))).toEqual([]);
  });

  it('knows its adapters', async () => {
    const { input, lines } = fakeInput(blankApp(), { adapter: 'vue' });
    expect(await new MakeAuthCommand().handle(input)).toBe(1);
    expect(lines[0]).toBe('✗ There are no auth templates for the UI adapter "vue". Known: react.');
  });

  it('makes one module, private by default — AUTH_PRIVATE_REGISTRATION=false turns it off, no flag of the command', async () => {
    expect(Object.keys(MakeAuthCommand.options)).toEqual(['force', 'adapter']);
    const defaults = blankApp();
    const plain = fakeInput(defaults);
    expect(await new MakeAuthCommand().handle(plain.input)).toBe(0);
    expect(plain.lines.filter((line) => line.startsWith('!'))).toEqual([]);
    expect(existsSync(join(STUBS, 'react', 'private-registration'))).toBe(false);
    // The change of address is pending by default and immediate with the switch off: both in the one controller.
    const controller = readFileSync(join(defaults, 'modules/auth/controllers/UpdateEmailController.ts'), 'utf8');
    expect(controller).toContain('requestEmailChange');
    expect(controller).toContain('changeEmail');
    // The users table is made with every column it has — no migration adds one later (no app is older than its table).
    const migrations = readdirSync(join(defaults, 'modules/auth/migrations')).filter((file) => file.includes('users_table'));
    expect(migrations).toEqual(['0001_01_01_000000_create_users_table.ts']);
    const users = readFileSync(join(defaults, 'modules/auth/migrations', migrations[0]!), 'utf8');
    for (const column of ['pending_email', 'pending_email_token', 'pending_email_expires_at', 'first_verified_at', 'session_key']) expect(users).toContain(`'${column}'`);
    expect(plain.lines).toContain('Registration and the change of address are private: they never tell whether an address has an account (AUTH_PRIVATE_REGISTRATION=false makes them say "taken").');
  });

  it("the web app's users table is made with the starter's account columns — no later migration adds them", () => {
    const folder = join(repo, 'apps/web-app/modules/auth/migrations');
    const files = readdirSync(folder).filter((file) => file.includes('users_table'));
    const create = files.find((file) => file.endsWith('_create_users_table.ts'))!;
    const columns = ['pending_email', 'pending_email_token', 'pending_email_expires_at', 'first_verified_at', 'session_key'];
    const users = readFileSync(join(folder, create), 'utf8');
    for (const column of columns) expect(users, `${create} makes no ${column}`).toContain(`'${column}'`);
    // Another migration that names one of them adds it to a table made without it — and backfills rows no app has.
    const later = files.filter((file) => file !== create && columns.some((column) => readFileSync(join(folder, file), 'utf8').includes(`'${column}'`)));
    expect(later, `later migrations of the users table add the starter's account columns: ${later.join(', ')}`).toEqual([]);
  });

  /**
   * A new app gets a complete auth area whose own tests pass — generated, migrated, type-checked and tested as a
   * user would. On Postgres too when `pnpm test:pgsql` runs.
   */
  it(
    'gives a new app a working auth area: its generated tests pass',
    () => {
      const root = blankApp();
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST') delete env[key];
      // Plain text whatever the CI colours: the assertions match the child Vitest's summary.
      const run = (command: string, args: string[], extra: Record<string, string> = {}, base = env) => {
        const result = spawnSync(command, args, { cwd: root, env: { ...base, NO_COLOR: '1', FORCE_COLOR: '0', ...extra }, encoding: 'utf8', timeout: 240_000 });
        return { code: result.status, out: stripVTControlCharacters(`${result.stdout}${result.stderr}`) };
      };
      // The CLI steps stay on the app's SQLite file; under `pnpm test:pgsql` only the generated tests use Postgres
      // (their own worker databases) — never the shared one.
      const { DB_CONNECTION: _connection, DB_URL: _url, ...sqliteEnv } = env;
      const marmeon = (...args: string[]) => run(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), ...args], { NODE_ENV: 'development' }, sqliteEnv);

      expect(marmeon('discover').code).toBe(0);
      const generated = marmeon('make:auth');
      expect(generated.out).toContain('Created modules/auth');
      expect(generated.code).toBe(0);
      // make:auth ran `marmeon route:types`: the module's routes, controllers and views are typed.
      const routeTypes = readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8');
      expect(generated.out).toContain('Wrote bootstrap/routes.ts');
      expect(routeTypes).toContain("'auth.login.store': { method: 'post'; path: '/login'; controller: typeof LoginController };");
      expect(routeTypes).toContain("'api.user': { method: 'get'; path: '/api/user'; browser: false };");
      expect(routeTypes).toContain("'auth/Dashboard': true;");
      // Private registration (the default): its page and the change link — answered with 404 when the switch is off.
      expect(routeTypes).toContain("'auth.register.sent': { method: 'get'; path: '/register/sent'; controller: typeof ShowRegistrationSentController };");
      expect(routeTypes).toContain("'auth.email.confirm': { method: 'get'; path: '/email/change/:id/:token'; controller: typeof ConfirmEmailChangeController; browser: false };");
      expect(routeTypes).toContain("'auth.passkeys': { method: 'get'; path: '/settings/passkeys'; controller: typeof ShowPasskeysController };");
      expect(routeTypes).toContain("'auth.two-factor.challenge': { method: 'get'; path: '/two-factor-challenge'; controller: typeof ShowTwoFactorChallengeController };");
      expect(marmeon('route:types', '--check').code).toBe(0);
      const migrated = marmeon('migrate');
      expect(migrated.out).toContain('create_personal_access_tokens_table');
      expect(migrated.out).toContain('create_users_table');
      expect(migrated.out).toContain('create_two_factor_tables');
      expect(migrated.out).toContain('create_passkeys_table');
      expect(migrated.out).toContain('create_sign_ins_table');
      expect(migrated.code).toBe(0);
      const tables = readFileSync(join(root, 'bootstrap/database.d.ts'), 'utf8');
      expect(tables).toContain('password: Secret<string>;');
      // The link's token hash is secret — never in `Row<'users'>`.
      expect(tables).toContain('pending_email_token: Secret<string | null>;');
      // The module's foreign keys relate its tables: `with('personal_access_tokens')` on users, `with('user')` on a token.
      expect(tables).toContain("personal_access_tokens: { kind: 'hasMany'; table: 'personal_access_tokens'; foreignKey: 'user_id';");
      expect(tables).toContain("user: { kind: 'belongsTo'; table: 'users'; foreignKey: 'user_id'; localKey: 'user_id'; targetKey: 'id'; nullable: false };");

      const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', root]);
      expect(typecheck.out).toBe('');
      expect(typecheck.code).toBe(0);

      // Clean under the lint preset the blank app carries, and with module boundaries too: views import controllers
      // with `import type`, other modules through their entry.
      const lint = () => run(join(root, 'node_modules/.bin/oxlint'), ['--deny-warnings']);
      expect(lint()).toMatchObject({ code: 0 });
      expect(marmeon('make:lint-config', '--boundaries', '--force').code).toBe(0);
      expect(lint()).toMatchObject({ code: 0 });

      // The first test boots the whole app cold (every module transformed): 3 to 5 s on a loaded machine, so the child run
      // does not hold it to Vitest's default 5 s.
      const tests = run(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'native', '--reporter=verbose', '--testTimeout=30000'], { NODE_OPTIONS: '--conditions=@marmeon/source', NODE_ENV: 'test' });
      const failed = [...tests.out.matchAll(/^\s*× (modules\/\S+ > .+?)(?: \d+ms)?$/gm)].map((match) => match[1]);
      expect(failed, `generated tests failed: ${failed.join(' | ')}\n${tests.out}`).toEqual([]);
      expect(tests.out).toMatch(/Tests\s+\d+ passed \(\d+\)/);
      expect(tests.out).not.toMatch(/\d+ failed/); // (verbose: a test's name may say "failed")
      // Both values of the switch: the private default and AUTH_PRIVATE_REGISTRATION=false, registration and change of address.
      const ran = (file: string, describe: string) => tests.out.match(new RegExp(`✓ modules/auth/${file}\\.test\\.ts > ${describe.replace(/[()]/g, '\\$&')}`, 'g'))?.length ?? 0;
      expect(ran('registration', 'private registration — the default')).toBe(6);
      expect(ran('registration', 'registration with AUTH_PRIVATE_REGISTRATION=false')).toBe(5);
      expect(ran('email-change', 'changing the address (private registration) — the default')).toBe(8);
      expect(ran('email-change', 'changing the address with AUTH_PRIVATE_REGISTRATION=false')).toBe(2);
      // Unconfirmed accounts are deleted after AUTH_UNVERIFIED_DAYS by the command, in both behaviours — the module schedules no
      // deletion (the app turns it on).
      expect(ran('prune-unverified', 'pruning accounts whose address was never confirmed — the default')).toBe(6);
      // … and never one that was confirmed — by its link or by `email_verified_at` alone — whatever its address became.
      expect(ran('prune-unverified', 'pruning accounts whose address was never confirmed with AUTH_PRIVATE_REGISTRATION=false')).toBe(3);
      // The passkey tests ran with the app's database (the software authenticator stands in for the browser), the mails' and the browser code's too.
      expect(ran('passkeys', 'passkeys')).toBe(24);
      expect(ran('passkeys', 'the mails about passkeys')).toBe(8);
      expect(ran('passkeys', 'marmeon auth:reset-two-factor and passkeys')).toBe(2);
      expect(ran('passkeys', 'an account with the authenticator app and a passkey')).toBe(1);
      expect(ran('account-failures', 'the failure ceiling of an account')).toBe(10);
      expect(ran('remember-theft','the mail about a copied "keep me signed in" cookie')).toBe(5);
      expect(ran('sign-ins', 'the sign-ins on the security page')).toBe(8);
      expect(ran('end-sessions', 'marmeon auth:end-sessions')).toBe(3);
      expect(ran('end-all-sessions', 'UserRepository.updateEverySessionKey()')).toBe(3);
      expect(ran('end-all-sessions', "AccountSessions.endEveryone() with the app's repository")).toBe(1);
      expect(ran('passkeys-browser', 'the base64url converters of the browser code')).toBe(3);
      expect(tests.code).toBe(0);

      // A stale bootstrap/routes.ts fails the CI check.
      const stalled = routeTypes.replace(/^ {4}'dashboard': .*\n/m, '');
      expect(stalled).not.toBe(routeTypes);
      writeFileSync(join(root, 'bootstrap/routes.ts'), stalled);
      const stale = marmeon('route:types', '--check');
      expect(stale.out).toContain('bootstrap/routes.ts is out of date — run: marmeon route:types');
      expect(stale.code).toBe(1);

      // The build regenerates it, and the client bundle carries only the routes its code names: no API route, no
      // `.internal()` route, none that only the server redirects to — their names and patterns stay on the server.
      const built = marmeon('build');
      expect(built.out).toContain('Built dist/client and dist/server');
      expect(built.code).toBe(0);
      expect(readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')).toContain("'auth.verification.verify': { method: 'get'; path: '/email/verify/:id/:hash'; controller: typeof VerifyEmailController; browser: false };");
      const client = readdirSync(join(root, 'dist/client'), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(root, 'dist/client', file), 'utf8'))
        .join('\n');
      expect(client).toContain('auth.login.store');
      // The look: the framework's stylesheet and the module's, in the stylesheet the built index.html links — no inline style.
      const css = readdirSync(join(root, 'dist/client'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.css'));
      const styles = css.map((file) => readFileSync(join(root, 'dist/client', file), 'utf8')).join('\n');
      expect(styles).toContain('.auth-header');
      expect(styles).toContain('.marmeon-layer');
      const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8');
      for (const file of css) expect(html, `index.html links ${file}`).toContain(`/${file}`);
      expect(client).toContain('/dashboard');
      expect(readFileSync(join(root, '.marmeon/routes.json'), 'utf8')).toContain('"auth.password.reset"'); // the browser may learn it …
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
