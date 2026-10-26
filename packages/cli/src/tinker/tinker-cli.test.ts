import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bin, environment, marmeon, session, webApp } from '../__fixtures__/tinker.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

describe('marmeon tinker (in the web app, SQLite)', { timeout: 60_000 }, () => {
  let dir: string;
  let env: Record<string, string>;
  const count = (extra: Record<string, string> = {}) => Number(marmeon(['tinker', '--execute', 'await repos.users.count()'], { ...env, ...extra }).stdout.trim());

  beforeAll(() => {
    dir = tempDir('marmeon-tinker-app-');
    env = { DB_DATABASE: join(dir, 'app.sqlite') };
    const fresh = marmeon(['migrate:fresh', '--seed', '--no-types'], env);
    expect(fresh.code, fresh.stderr).toBe(0);
  });

  it('prints the value of --execute — the number of users', () => {
    const { code, stdout, stderr } = marmeon(['tinker', '--execute', 'await repos.users.count()'], env);
    expect(code, stderr).toBe(0);
    const query = marmeon(['tinker', '-e', "Number((await db.selectFrom('users').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)"], env);
    expect(stdout).toBe(`${query.stdout.trim()}\n`);
    expect(Number(stdout)).toBeGreaterThan(0);
  });

  it('takes TypeScript and prints strings as they are (for scripts)', () => {
    const typed = marmeon(['tinker', '-e', 'interface Greeting { name: string }\nconst hello = (g: Greeting): string => `hello ${g.name}`;\nhello({ name: "Ada" } satisfies Greeting)'], env);
    expect(typed.stdout).toBe('hello Ada\n');
    expect(marmeon(['tinker', '-e', "url('user-profile.show', { user: 7 }, { tab: 'links' })"], env).stdout).toBe('/users/7?tab=links\n');
  });

  it('evaluates in the process’s own realm — a Date typed in is the framework’s Date', () => {
    // In a context of its own, `new Date()` is another realm's Date: the SQLite driver could not bind it.
    const { stdout, stderr } = marmeon(['tinker', '--sandbox', '-e', 'await repos.users.update(1, { email_verified_at: new Date(0) }); (await repos.users.find(1))!.email_verified_at'], env);
    expect(stdout, stderr).toBe('1970-01-01T00:00:00.000Z\n');
  });

  it('exits with 1 on an error — its stack without the evaluation, a TypeScript error by name', () => {
    const failed = marmeon(['tinker', '-e', 'await repos.users.findOrFail(987654)'], env);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/^✗ RecordNotFoundError: Not Found\n {4}at UserRepository\.findOrFail \(.*repository\.ts:\d+:\d+\)\n {4}at async REPL:1:\d+\n$/);
    const typescript = marmeon(['tinker', '-e', 'enum Role { Admin }'], env);
    expect(typescript.code).toBe(1);
    expect(typescript.stderr).toBe('✗ SyntaxError: TypeScript enum is not supported in strip-only mode\n');
  });

  it('keeps the sandbox transaction across inputs and rolls it back at the end — the database queue with it', async () => {
    const before = count();
    const { code, stdout } = await session(['--sandbox', '--no-history'], env, [
      `await repos.users.insert({ name: 'Tinker', email: 'tinker@example.com', password: 'x', locale: 'en' }); 'inserted'`,
      // The second input sees the first one's row: the same transaction.
      "`users:${await repos.users.count()}`",
      'await jobs.dispatch(SendWelcomeMailJob, { userId: 1 }); `jobs:${(await db.selectFrom("jobs").selectAll().execute()).length}`',
      '.exit',
      '',
    ].join('\n'));
    expect(code).toBe(0);
    expect(stdout).toContain('Sandbox: every change to the default connection is rolled back when the session ends');
    expect(stdout).toContain(`'users:${before + 1}'`);
    expect(stdout).toContain("'jobs:1'");
    expect(stdout).toContain('ℹ Sandbox: rolled back.');
    expect(count()).toBe(before);
    expect(marmeon(['tinker', '-e', '(await db.selectFrom("jobs").selectAll().execute()).length'], env).stdout).toBe('0\n');
  });

  it('rolls the sandbox back on SIGINT', async () => {
    const before = count();
    const child = spawn(process.execPath, [bin, 'tinker', '--sandbox', '--no-history'], { cwd: webApp, env: environment(env) });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => (stdout += data));
    const inserted = new Promise<void>((resolve) => child.stdout.on('data', () => stdout.includes("'inserted'") && resolve()));
    child.stdin.write(`await repos.users.insert({ name: 'Signal', email: 'signal@example.com', password: 'x', locale: 'en' }); 'inserted'\n`);
    await inserted;
    child.kill('SIGINT');
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(130);
    expect(stdout).toContain('ℹ Sandbox: rolled back.');
    expect(count()).toBe(before);
  });

  it('says why the cache cannot write on the app’s SQLite file inside the sandbox — instead of waiting', () => {
    const { code, stderr } = marmeon(['tinker', '--sandbox', '-e', "await make('Cache').put('greeting', 'hello', 60)"], { ...env, CACHE_DRIVER: 'database', CACHE_CONNECTION: 'default' });
    expect(code).toBe(1);
    expect(stderr).toContain('✗ InfrastructureTransactionError: The cache (CACHE_DRIVER=database');
    expect(stderr).toContain('! In --sandbox the whole session runs in one transaction on the default connection');
    // Without the sandbox, the same write works.
    expect(marmeon(['tinker', '-e', "await make('Cache').put('greeting', 'hello', 60); await make('Cache').get('greeting')"], { ...env, CACHE_DRIVER: 'database', CACHE_CONNECTION: 'default' }).stdout).toBe('hello\n');
  });

  it('logs without a request context', () => {
    const { stdout } = marmeon(['tinker', '-e', "make('Logger').info('from tinker', { step: 4 }); 'logged'"], { ...env, LOG_LEVEL: 'info', LOG_FORMAT: 'json' });
    const line = stdout.split('\n').find((text) => text.includes('from tinker'));
    // The app's environment on every entry (APP_ENV, by default the one NODE_ENV=test goes with).
    expect(JSON.parse(line!)).toEqual({ level: 30, time: expect.any(Number), appEnv: 'testing', step: 4, msg: 'from tinker' });
  });

  it('shows the environment and the database in the banner — in production as a warning, never a secret', async () => {
    // Outside NODE_ENV=test the app reads .env, which a fresh checkout (CI) does not have: the test brings its configuration.
    const config = { APP_NAME: 'Marmeon', APP_URL: 'http://localhost', APP_KEY: `base64:${Buffer.alloc(32, 7).toString('base64')}`, SYSTEM_DB_DATABASE: ':memory:', LOG_LEVEL: 'silent', PAYMENTS_WEBHOOK_SECRET: Buffer.alloc(24, 5).toString('hex') };
    const production = { ...env, ...config, NODE_ENV: 'production' };
    const development = await session(['--no-history'], { ...env, ...config, NODE_ENV: 'development', DEVTOOLS_ENABLED: 'false' }, '.exit\n');
    expect(development.stdout).toContain(`Marmeon tinker · @marmeon/web-app · NODE_ENV=development · APP_ENV=local · db sqlite (${env.DB_DATABASE}) · .ls lists helpers`);
    expect(development.stdout).not.toContain('PRODUCTION');
    const interactive = await session(['--no-history'], production, '.exit\n');
    expect(interactive.stdout).toContain(`PRODUCTION — NODE_ENV=production, APP_ENV=production, db sqlite (${env.DB_DATABASE}): every change is real.`);
    expect(interactive.stdout).not.toContain(production.APP_KEY);
    // --execute: the value alone on stdout, the warning on stderr.
    const script = marmeon(['tinker', '--sandbox', '-e', '1 + 1'], production);
    expect(script.stdout).toBe('2\n');
    expect(script.stderr).toContain('PRODUCTION — NODE_ENV=production, APP_ENV=production, db sqlite');
    expect(script.stderr).toContain('changes are rolled back at the end (--sandbox).');
    // A staging server: production, named by APP_ENV — and APP_ENV=local unprotects nothing.
    const staging = marmeon(['tinker', '-e', '1 + 1'], { ...env, ...config, NODE_ENV: 'production', APP_ENV: 'staging' });
    expect(staging.stderr).toContain('PRODUCTION — NODE_ENV=production, APP_ENV=staging, db sqlite');
    const local = marmeon(['tinker', '-e', '1 + 1'], { ...env, ...config, NODE_ENV: 'production', APP_ENV: 'local' });
    expect(local.stderr).toContain('PRODUCTION — NODE_ENV=production, APP_ENV=local, db sqlite');
    // Any other NODE_ENV does not start: the start error, nothing evaluated.
    const unknown = marmeon(['tinker', '-e', '1 + 1'], { ...env, ...config, NODE_ENV: 'staging' });
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging');
  });

  it('leaves the history file as it was with --no-history', async () => {
    const history = join(webApp, 'storage/framework/tinker_history');
    const snapshot = () => (existsSync(history) ? readFileSync(history, 'utf8') : undefined);
    const before = snapshot();
    const { code } = await session(['--no-history'], env, "'x'\n.exit\n");
    expect(code).toBe(0);
    expect(snapshot()).toBe(before);
  });
});
