import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { main } from './main.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const blank = join(repo, 'apps', 'blank-app');

/**
 * The starter kit as a user gets it, run end to end once: the template and the home module, then the app's own `make:auth`,
 * `migrate`, the type check, the lint preset (with module boundaries too), its tests (auth, home, system) and `build`. The
 * framework comes from the workspace (the blank app's node_modules); `pnpm pack:smoke` does the same from the tarballs, outside
 * the monorepo. On Postgres too when `pnpm test:pgsql` runs: only the nested Vitest sees the `DB_*` variables.
 */
it(
  'the starter kit works: make:auth, migrate, typecheck, lint, build and its tests pass',
  async () => {
    const cwd = tempDir('marmeon-kit-');
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
    // The blank app's installed packages, plus the kit's font (the website has the same version): the build resolves it.
    mkdirSync(join(root, 'node_modules'));
    for (const entry of readdirSync(join(blank, 'node_modules'))) if (!entry.startsWith('.') || entry === '.bin') symlinkSync(join(blank, 'node_modules', entry), join(root, 'node_modules', entry));
    symlinkSync(join(repo, 'apps/website/node_modules/@fontsource-variable'), join(root, 'node_modules/@fontsource-variable'), 'dir');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV') delete env[key];
    // Plain text whatever the CI colours: the assertions match the child Vitest's summary.
    const run = (command: string, args: string[], extra: Record<string, string> = {}, base = env) => {
      const result = spawnSync(command, args, { cwd: root, env: { ...base, NO_COLOR: '1', FORCE_COLOR: '0', ...extra }, encoding: 'utf8', timeout: 240_000 });
      return { code: result.status, out: stripVTControlCharacters(`${result.stdout}${result.stderr}`) };
    };
    // The CLI steps stay on the app's SQLite file; under `pnpm test:pgsql` only the generated tests use Postgres
    // (their own worker databases) — never the shared one.
    const { DB_CONNECTION: _connection, DB_URL: _url, ...sqliteEnv } = env;
    // As the scaffolder runs them after the install: NODE_ENV from the app's .env (development).
    const marmeon = (...args: string[]) => run(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), ...args], {}, sqliteEnv);

    const generated = marmeon('make:auth');
    expect(generated.out).toContain('Created modules/auth');
    expect(generated.out).toContain('Wrote bootstrap/routes.ts');
    expect(generated.code).toBe(0);
    // … and recorded the copied files, where they came from and their hashes (the migrations carry their own mark).
    const stubs = JSON.parse(readFileSync(join(root, 'marmeon-stubs.json'), 'utf8')) as { format: number; sets: Record<string, { package: string; files: Record<string, unknown> }> };
    expect(stubs.format).toBe(1);
    expect(stubs.sets['@marmeon/auth:react/modules/auth']?.package).toBe('@marmeon/auth');
    expect(stubs.sets['@marmeon/auth:react/modules/auth']?.files).toHaveProperty(['modules/auth/routes.ts']);
    // make:auth ran `marmeon route:types`: the module's routes, controllers and views are typed.
    const routeTypes = readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8');
    expect(routeTypes).toContain("'home': { method: 'get'; path: '/'; controller: typeof ShowHomeController };");
    expect(routeTypes).toContain("'auth.login.store': { method: 'post'; path: '/login'; controller: typeof LoginController };");
    expect(routeTypes).toContain("'api.user': { method: 'get'; path: '/api/user'; browser: false };");
    expect(routeTypes).toContain("'auth/Dashboard': true;");
    // Private registration (the default): its page and the change link — answered with 404 when the switch is off.
    expect(routeTypes).toContain("'auth.register.sent': { method: 'get'; path: '/register/sent'; controller: typeof ShowRegistrationSentController };");
    expect(routeTypes).toContain("'auth.email.confirm': { method: 'get'; path: '/email/change/:id/:token'; controller: typeof ConfirmEmailChangeController; browser: false };");
    expect(routeTypes).toContain("'auth.passkeys': { method: 'get'; path: '/settings/passkeys'; controller: typeof ShowPasskeysController };");
    expect(routeTypes).toContain("'auth.two-factor.challenge': { method: 'get'; path: '/two-factor-challenge'; controller: typeof ShowTwoFactorChallengeController };");
    expect(marmeon('route:types', '--check').code).toBe(0);
    // The order counts: at equal specificity the module's class rules must come after the kit's base rules.
    const client = readFileSync(join(root, 'bootstrap/client.tsx'), 'utf8');
    expect(client.match(/styles\/app\.css/g)).toHaveLength(1);
    expect(client.indexOf('../styles/app.css')).toBeGreaterThan(client.indexOf('@marmeon/react/styles.css'));
    expect(client.indexOf('../styles/app.css')).toBeLessThan(client.indexOf('modules/auth/auth.css'));

    const migrated = marmeon('migrate');
    expect(migrated.out).toContain('Environment: development (APP_ENV=local, NODE_ENV from .env)');
    expect(migrated.out).toContain('create_personal_access_tokens_table');
    expect(migrated.out).toContain('create_users_table');
    expect(migrated.out).toContain('create_two_factor_tables');
    expect(migrated.out).toContain('create_passkeys_table');
    expect(migrated.out).toContain('create_sign_ins_table');
    expect(migrated.out).toContain('create_email_changes_table');
    expect(migrated.code).toBe(0);
    // The kit is written at the current revision of its tables: nothing is left to upgrade, and nothing renames a table.
    const upgrades = marmeon('make:upgrade-migrations', '--check');
    expect(upgrades.out).toContain("The framework's tables have every migration of the installed packages.");
    expect(upgrades.code).toBe(0);
    expect(readdirSync(join(root, 'modules/auth/migrations')).filter((file) => /rename/.test(file))).toEqual([]);
    const tables = readFileSync(join(root, 'bootstrap/database.d.ts'), 'utf8');
    expect(tables).toContain('password: Secret<string>;');
    // A change of address waits in its own table, whose token hash and session key are secret — `users` holds no address its owner has not confirmed.
    expect(tables).toMatch(/email_changes: \{[^}]*token_hash: Secret<string>;[^}]*session_key: Secret<string \| null>;/);
    expect(tables).not.toContain('pending_email');
    // The module's foreign keys relate its tables: `with('personal_access_tokens')` on users, `with('user')` on a token.
    expect(tables).toContain("personal_access_tokens: { kind: 'hasMany'; table: 'personal_access_tokens'; foreignKey: 'user_id';");
    expect(tables).toContain("user: { kind: 'belongsTo'; table: 'users'; foreignKey: 'user_id'; localKey: 'user_id'; targetKey: 'id'; nullable: false };");

    const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', root]);
    expect(typecheck.out).toBe('');
    expect(typecheck.code).toBe(0);

    // Clean under the lint preset the app carries, and with module boundaries too: views import controllers with
    // `import type`, other modules through their entry.
    const linted = (...paths: string[]) => {
      const result = run(join(root, 'node_modules/.bin/oxlint'), ['--deny-warnings', ...paths]);
      expect(result.code, result.out).toBe(0);
    };
    linted();
    // The boundaries are checked on the modules the blank app has, auth and system: the kit's home view takes the auth module's layout by its file.
    expect(marmeon('make:lint-config', '--boundaries', '--force').code).toBe(0);
    linted('modules/auth', 'modules/system');

    // The first test boots the whole app cold (every module transformed): slower than Vitest's default 5 s on a loaded machine.
    const tests = run(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'native', '--reporter=verbose', '--testTimeout=30000'], { NODE_OPTIONS: '--conditions=@marmeon/source', NODE_ENV: 'test' });
    expect(tests.out).toContain('modules/home/home.test.ts');
    // The app's dialog in the page's language: the guard's question — and tab sync's — in German too.
    expect(tests.out).toContain('modules/home/confirm.test.ts');
    // The failing tests by name — the message (Vitest shortens a long output it prints).
    const failed = tests.out.split('\n').filter((line) => /^\s*(×|FAIL)/.test(line)).join('\n');
    expect(tests.out, `the kit's tests failed:\n${failed}`).toMatch(/Tests\s+\d+ passed \(\d+\)/);
    expect(tests.out, `the kit's tests failed:\n${failed}`).not.toMatch(/Tests\s+\d+ failed/);
    // Both values of the switch: the private default and AUTH_PRIVATE_REGISTRATION=false, registration and change of address.
    const ran = (file: string, describe: string) => tests.out.match(new RegExp(`✓ modules/auth/${file}\\.test\\.ts > ${describe.replace(/[()]/g, '\\$&')}`, 'g'))?.length ?? 0;
    expect(ran('registration', 'private registration — the default')).toBe(8);
    expect(ran('registration', 'registration with AUTH_PRIVATE_REGISTRATION=false')).toBe(5);
    expect(ran('email-change', 'changing the address (private registration) — the default')).toBe(14);
    expect(ran('email-change', 'changing the address with AUTH_PRIVATE_REGISTRATION=false')).toBe(3);
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
    expect(ran('route-limits', 'the limits of the auth routes')).toBe(3);
    expect(ran('login-limits', 'the ceiling on the password sign-ins of an account')).toBe(14);
    expect(ran('remember-theft', 'the mail about a copied "keep me signed in" cookie')).toBe(6);
    expect(ran('sign-ins', 'the sign-ins on the security page')).toBe(8);
    expect(ran('end-sessions', 'marmeon auth:end-sessions')).toBe(3);
    expect(ran('end-all-sessions', 'UserRepository.updateEverySessionKey()')).toBe(3);
    expect(ran('end-all-sessions', "AccountSessions.endEveryone() with the app's repository")).toBe(1);
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
    const files = readdirSync(join(root, 'dist/client'), { recursive: true, encoding: 'utf8' });
    const bundle = files
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(root, 'dist/client', file), 'utf8'))
      .join('\n');
    expect(bundle).toContain('auth.login.store');
    // The look: the framework's stylesheet and the module's, in the stylesheet the built index.html links — no inline style.
    const css = files.filter((file) => file.endsWith('.css'));
    const styles = css.map((file) => readFileSync(join(root, 'dist/client', file), 'utf8')).join('\n');
    expect(styles).toContain('.auth-header');
    expect(styles).toContain('.marmeon-layer');
    const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8');
    for (const file of css) expect(html, `index.html links ${file}`).toContain(`/${file}`);
    expect(bundle).toContain('/dashboard');
    expect(readFileSync(join(root, '.marmeon/routes.json'), 'utf8')).toContain('"auth.password.reset"'); // the browser may learn it …
    for (const serverOnly of ['auth.password.reset', 'auth.password.confirm', 'auth.verification.notice']) {
      expect(bundle).not.toMatch(new RegExp(`[\`"']${serverOnly.replaceAll('.', '\\.')}[\`"']`)); // … but no view names it
    }
    expect(bundle).not.toContain('auth.verification.verify');
    expect(bundle).not.toContain('/email/verify/:id/:hash');
    expect(bundle).not.toContain('api.user');
    expect(bundle).not.toMatch(/["'`]\/api\/user["'`]/); // the page text mentions /api/users — the pattern itself must be absent
  },
  300_000,
);
